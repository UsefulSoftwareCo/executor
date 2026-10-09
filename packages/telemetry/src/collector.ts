/** Effect owns the bundled Motel workerd process and restarts it after unexpected exits. */
import { createRequire } from "node:module";
import { Deferred, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** workerd's control message once the collector socket accepts connections. */
const Listening = Schema.Struct({
  event: Schema.Literal("listen"),
  socket: Schema.Literal("motel"),
  port: Schema.Number.check(
    Schema.makeFilter((port) => Number.isInteger(port) && port > 0 && port < 65_536),
  ),
});

const WorkerdPackage = Schema.Struct({ default: Schema.String });

/**
 * Serve the Motel bundle with the workerd executable the runtime already ships. The bundle's
 * config names its data and asset directories; the host supplies their paths and the port.
 * Port 0 binds any free port, which workerd reports on descriptor 3.
 */
const serveMotel = (bundle: string, data: string, port: number) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const workerd = yield* Effect.try(() => createRequire(import.meta.url)("workerd")).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(WorkerdPackage)),
    );
    const child = yield* processes.spawn(
      ChildProcess.make(
        workerd.default,
        [
          "serve",
          "--control-fd=3",
          `--directory-path=motel-data=${data}`,
          `--directory-path=motel-assets=${path.join(bundle, "web/dist")}`,
          `--socket-addr=motel=127.0.0.1:${port}`,
          path.join(bundle, "motel.capnp"),
        ],
        {
          // A process's working directory cannot be removed or renamed on Windows. workerd can
          // outlive the parent's reported exit while it terminates, so it never runs inside data.
          cwd: bundle,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          additionalFds: { fd3: { type: "output" } },
          // workerd does not watch its parent. It shares the parent's process group on POSIX and
          // Node's kill-on-close job on Windows, so stopping the parent also stops workerd.
          detached: false,
          killSignal: "SIGTERM",
          forceKillAfter: 3_000,
        },
      ),
    );
    const listening = yield* Deferred.make<number>();
    yield* child.getOutputFd(3).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Listening))(line).pipe(
          Effect.flatMap((message) => Deferred.succeed(listening, message.port)),
          Effect.ignore,
        ),
      ),
      Effect.forkScoped,
    );
    return { child, listening: Deferred.await(listening) };
  });

/** Start supervision immediately; only exports await the collector's first ready address. */
export const startCollector = (directory: string, bundle: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const initial = yield* Deferred.make<string>();
    const statusPath = path.join(directory, "collector.json");
    const data = path.join(directory, "motel");
    yield* fs.makeDirectory(data, { recursive: true, mode: 0o700 });
    let pid: number | undefined;
    // A restart keeps the first bound port, so exporters keep one address.
    let port = 0;
    const url = () => `http://127.0.0.1:${port}`;
    // Read the process and port when the write runs, not when the pipeline is built.
    const status = (state: "starting" | "running" | "restarting" | "stopped") =>
      Effect.suspend(() =>
        fs.writeFileString(
          `${statusPath}.tmp`,
          JSON.stringify(
            { state, pid, ...(port === 0 ? {} : { url: url() }), database: data },
            null,
            2,
          ),
          { mode: 0o600 },
        ),
      ).pipe(Effect.andThen(fs.rename(`${statusPath}.tmp`, statusPath)));
    yield* status("starting");
    yield* Effect.addFinalizer(() => status("stopped").pipe(Effect.orDie));
    const run = Effect.scoped(
      Effect.gen(function* () {
        const { child, listening } = yield* serveMotel(bundle, data, port);
        pid = child.pid;
        yield* Effect.forEach(
          [child.stdout, child.stderr],
          (output) =>
            output.pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.runForEach((line) =>
                Effect.logInfo(line).pipe(Effect.annotateLogs({ process: "motel" })),
              ),
              Effect.forkScoped,
            ),
          { discard: true },
        );
        yield* listening.pipe(
          Effect.tap((bound) =>
            Effect.gen(function* () {
              port = bound;
              yield* status("running");
              yield* Deferred.succeed(initial, url());
              yield* Effect.logInfo("Local telemetry collector ready").pipe(
                Effect.annotateLogs({ url: url() }),
              );
            }),
          ),
          Effect.timeout("10 seconds"),
          Effect.raceFirst(child.exitCode),
        );
        const code = yield* child.exitCode;
        yield* Effect.logWarning("Local telemetry collector exited").pipe(
          Effect.annotateLogs({ exitCode: code }),
        );
      }),
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Local telemetry collector failed", cause)),
      Effect.andThen(status("restarting")),
      Effect.andThen(Effect.sleep("3 seconds")),
    );
    yield* run.pipe(Effect.forever, Effect.forkScoped);
    return Deferred.await(initial);
  });
