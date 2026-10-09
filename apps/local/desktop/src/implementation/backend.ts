import {
  Deferred,
  Effect,
  Fiber,
  Option,
  type PlatformError,
  Queue,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  DesktopBootstrap,
  ServerReady,
  type LocalConfigurationReason,
} from "@executor-js/local-server/auth";
import {
  DesktopBackendMessage,
  DesktopCallback,
  DesktopConfigurationFailed,
  DesktopFailed,
  LocalOrigin,
} from "../contracts/desktop.ts";

/** Stderr kept for one run. It reaches diagnostics only when that run fails. */
const stderrTailBytes = 256 * 1024;
/** Output readers finish at pipe EOF; a leaked descriptor must not delay exit handling. */
const drainTimeout = "1 second";

/** How one backend process ended. */
export interface BackendExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** The parent asked this process to stop (quit, reset or a supervised restart). */
  readonly stoppedByUs: boolean;
  /** The process reported readiness before it exited. */
  readonly ready: boolean;
  /** Key setup refused to start; see the private fd4 message. */
  readonly configuration: Option.Option<LocalConfigurationReason>;
  /** The last output written to stderr, bounded by `stderrTailBytes`. */
  readonly stderr: string;
}

/** Signals and POSIX 128+N exit codes that mean "stop", as opposed to "you are broken". */
const shutdownSignals: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);
const shutdownCodes: ReadonlySet<number> = new Set([129, 130, 143]);

/**
 * Ported from the original desktop's sidecar classifier. A managed stop needs no recovery. An
 * external shutdown (for example a group SIGINT) is not a crash, but the server is still gone.
 */
export type BackendExitKind =
  | { readonly kind: "managed-stop" }
  | { readonly kind: "external-shutdown"; readonly reason: string }
  | { readonly kind: "crash" };

export const classifyBackendExit = (
  exit: Pick<BackendExit, "code" | "signal" | "stoppedByUs">,
  appQuitting: boolean,
): BackendExitKind => {
  if (exit.stoppedByUs || appQuitting) return { kind: "managed-stop" };
  if (exit.signal !== null && shutdownSignals.has(exit.signal))
    return { kind: "external-shutdown", reason: exit.signal };
  if (exit.code !== null && shutdownCodes.has(exit.code))
    return { kind: "external-shutdown", reason: `code ${exit.code}` };
  return { kind: "crash" };
};

/** Keep the newest bytes, dropping whole chunks first and trimming the oldest retained one. */
const appendTail = (chunks: ReadonlyArray<Uint8Array>, chunk: Uint8Array) => {
  const next = [
    ...chunks,
    chunk.byteLength > stderrTailBytes ? chunk.slice(-stderrTailBytes) : chunk,
  ];
  let size = next.reduce((total, current) => total + current.byteLength, 0);
  while (size > stderrTailBytes) {
    const first = next[0]!;
    const excess = size - stderrTailBytes;
    if (first.byteLength <= excess) {
      next.shift();
      size -= first.byteLength;
    } else {
      next[0] = first.slice(excess);
      size -= excess;
    }
  }
  return next;
};

/** The Node spawner reports a signal exit as a failure whose cause names the signal. */
const signalOf = (error: PlatformError.PlatformError) => {
  const cause = error.reason.cause;
  return cause instanceof Error ? (/signal: '([A-Z0-9]+)'/.exec(cause.message)?.[1] ?? null) : null;
};

/**
 * Start one scoped backend process. fd3 carries its one-use bootstrap token, stdout readiness and
 * fd4 OAuth callbacks or a configuration failure. Closing the scope stops the process.
 */
export const startBackend = (options: {
  readonly executable: string;
  readonly entry: string;
  readonly cwd: string;
  readonly directory: string;
  readonly collectorBundle: string;
  readonly development: boolean;
  /** The saved desktop port. Undefined keeps an inherited EXECUTOR_PORT or the server default. */
  readonly port: number | undefined;
  readonly token: (typeof DesktopBootstrap.Type)["token"];
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bootstrap = yield* Schema.encodeEffect(Schema.fromJsonString(DesktopBootstrap))({
      version: 1,
      token: options.token,
    }).pipe(Effect.mapError(() => new DesktopFailed({ stage: "start" })));
    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.executable, [options.entry], {
          cwd: options.cwd,
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            EXECUTOR_DATA_DIR: options.directory,
            EXECUTOR_MOTEL_BUNDLE: options.collectorBundle,
            EXECUTOR_DESKTOP_DEV: options.development ? "1" : "0",
            ...(options.port === undefined ? {} : { EXECUTOR_PORT: String(options.port) }),
            // A desktop callback must return to its owned loopback listener.
            EXECUTOR_BROWSER_ORIGIN: undefined,
          },
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          additionalFds: {
            fd3: { type: "input", stream: Stream.make(bootstrap).pipe(Stream.encodeText) },
            fd4: { type: "output" },
          },
          killSignal: "SIGTERM",
          forceKillAfter: 4_000,
        }),
      )
      .pipe(
        Effect.tapCause((cause) => Effect.logError("Desktop backend could not start", cause)),
        Effect.mapError(() => new DesktopFailed({ stage: "start" })),
      );
    yield* Effect.logInfo("Desktop backend started").pipe(Effect.annotateLogs({ pid: child.pid }));

    // stderr is diagnostic output; stdout and private descriptors remain protocol-only.
    const stderr = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
    const stderrReader = yield* child.stderr.pipe(
      Stream.runForEach((chunk) => Ref.update(stderr, (chunks) => appendTail(chunks, chunk))),
      Effect.ignore,
      Effect.forkScoped,
    );

    const configuration = yield* Ref.make(Option.none<LocalConfigurationReason>());
    const callbacks = yield* Queue.unbounded<typeof DesktopCallback.Type>();
    const messageReader = yield* child.getOutputFd(4).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopBackendMessage))(line).pipe(
          Effect.flatMap((message) =>
            Schema.is(DesktopConfigurationFailed)(message)
              ? Ref.set(configuration, Option.some(message.configuration))
              : Queue.offer(callbacks, message),
          ),
          Effect.catch(() => Effect.logWarning("Desktop backend sent an invalid private message")),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );

    const ready = yield* Deferred.make<string, DesktopFailed>();
    const reported = yield* Ref.make(false);
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(ServerReady))(line).pipe(
          Effect.flatMap((message) => Schema.decodeUnknownEffect(LocalOrigin)(message.url)),
          Effect.mapError(() => new DesktopFailed({ stage: "ready" })),
          Effect.matchEffect({
            onFailure: (error) => Deferred.fail(ready, error),
            onSuccess: (origin) =>
              Ref.set(reported, true).pipe(Effect.andThen(Deferred.succeed(ready, origin))),
          }),
        ),
      ),
      Effect.catch(() => Deferred.fail(ready, new DesktopFailed({ stage: "ready" }))),
      Effect.forkScoped,
    );

    const stoppedByUs = yield* Ref.make(false);
    const exited = yield* Deferred.make<BackendExit>();
    yield* child.exitCode.pipe(
      Effect.match({
        onSuccess: (code) => ({ code: Number(code), signal: null }),
        onFailure: (error) => ({ code: null, signal: signalOf(error) }),
      }),
      Effect.flatMap(({ code, signal }) =>
        Effect.gen(function* () {
          yield* Effect.all([Fiber.await(stderrReader), Fiber.await(messageReader)], {
            concurrency: 2,
            discard: true,
          }).pipe(Effect.timeoutOption(drainTimeout));
          const tail = yield* Ref.get(stderr);
          const exit: BackendExit = {
            code,
            signal,
            stoppedByUs: yield* Ref.get(stoppedByUs),
            ready: yield* Ref.get(reported),
            configuration: yield* Ref.get(configuration),
            stderr: new TextDecoder().decode(Buffer.concat(tail)),
          };
          yield* Deferred.succeed(exited, exit);
        }),
      ),
      Effect.forkScoped,
    );

    return {
      pid: Number(child.pid),
      /** Resolves with the parsed loopback origin; fails on a bad readiness line. */
      ready: Deferred.await(ready),
      /** Resolves once the process has exited and its output has drained. */
      exited: Deferred.await(exited),
      /** OAuth callbacks for this run only. */
      callbacks: Stream.fromQueue(callbacks),
      pairingUrl: (origin: string) => `${origin}/#pair=${Redacted.value(options.token)}`,
      /** Ask the process to stop and wait for its exit; forced after four seconds. */
      stop: Ref.set(stoppedByUs, true).pipe(
        Effect.andThen(child.kill({ killSignal: "SIGTERM", forceKillAfter: 4_000 })),
        Effect.ignore,
        Effect.andThen(Deferred.await(exited)),
      ),
    };
  });

export type BackendRun = Effect.Success<ReturnType<typeof startBackend>>;
