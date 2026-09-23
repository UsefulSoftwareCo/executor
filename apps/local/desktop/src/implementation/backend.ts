import { Deferred, Effect, Redacted, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { DesktopBootstrap, ServerReady } from "@executor-js/local-server/auth";
import { DesktopCallback, DesktopFailed, LocalOrigin } from "../contracts/desktop.ts";

/** Start one scoped backend. fd3 carries bootstrap, stdout readiness, and fd4 OAuth callbacks. */
export const startBackend = (options: {
  readonly executable: string;
  readonly entry: string;
  readonly cwd: string;
  readonly directory: string;
  readonly collectorBundle: string;
  readonly development: boolean;
  readonly token: (typeof DesktopBootstrap.Type)["token"];
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bootstrap = yield* Schema.encodeEffect(Schema.fromJsonString(DesktopBootstrap))({
      version: 1,
      token: options.token,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.executable, [options.entry], {
          cwd: options.cwd,
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            EXECUTOR_DATA_DIR: options.directory,
            EXECUTOR_MOTEL_BUNDLE: options.collectorBundle,
            EXECUTOR_DESKTOP_DEV: options.development ? "1" : "0",
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
    // stderr is diagnostic output; stdout and private descriptors remain protocol-only.
    yield* child.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.logInfo(line).pipe(Effect.annotateLogs({ process: "backend" })),
      ),
      Effect.forkScoped,
    );
    const ready = yield* Deferred.make<string, DesktopFailed>();
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(ServerReady))(line).pipe(
          Effect.flatMap((message) => Schema.decodeUnknownEffect(LocalOrigin)(message.url)),
          Effect.mapError(() => new DesktopFailed({ stage: "ready" })),
          Effect.matchEffect({
            onFailure: (error) => Deferred.fail(ready, error),
            onSuccess: (origin) => Deferred.succeed(ready, origin),
          }),
        ),
      ),
      Effect.catch(() => Deferred.fail(ready, new DesktopFailed({ stage: "ready" }))),
      Effect.forkScoped,
    );
    const exited = child.exitCode.pipe(
      Effect.tap((code) =>
        Effect.logWarning("Desktop backend exited").pipe(Effect.annotateLogs({ exitCode: code })),
      ),
      Effect.flatMap(() => Effect.fail(new DesktopFailed({ stage: "server-exit" }))),
      Effect.mapError(() => new DesktopFailed({ stage: "server-exit" })),
    );
    const origin = yield* Effect.raceFirst(Deferred.await(ready), exited).pipe(
      Effect.timeoutOrElse({
        duration: 60_000,
        orElse: () => Effect.fail(new DesktopFailed({ stage: "ready" })),
      }),
    );
    const callbacks = child.getOutputFd(4).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.mapEffect((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopCallback))(line),
      ),
      Stream.mapError(() => new DesktopFailed({ stage: "oauth" })),
    );
    return {
      origin,
      callbacks,
      exited,
      pairingUrl: `${origin}/#pair=${Redacted.value(options.token)}`,
    };
  });
