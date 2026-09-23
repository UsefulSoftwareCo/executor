/** Effect owns the bundled Motel child and restarts it after unexpected exits. */
import { Deferred, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const Ready = Schema.Struct({
  version: Schema.Literal(1),
  url: Schema.String.check(
    Schema.makeFilter((text) => {
      const url = URL.parse(text);
      return (
        url !== null &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        Number(url.port) > 0 &&
        url.pathname === "/"
      );
    }),
  ),
});

/** Start supervision immediately; only exports await the collector's first ready address. */
export const startCollector = (directory: string, bundle: string, executable: "bun" | "bun.exe") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const initial = yield* Deferred.make<string>();
    const statusPath = path.join(directory, "collector.json");
    let pid: number | undefined;
    let url = "http://127.0.0.1:0";
    const status = (state: "starting" | "running" | "restarting" | "stopped") =>
      fs
        .writeFileString(
          `${statusPath}.tmp`,
          JSON.stringify(
            {
              state,
              pid,
              ...(url.endsWith(":0") ? {} : { url }),
              database: path.join(directory, "telemetry.sqlite"),
            },
            null,
            2,
          ),
          { mode: 0o600 },
        )
        .pipe(Effect.andThen(fs.rename(`${statusPath}.tmp`, statusPath)));
    yield* status("starting");
    yield* Effect.addFinalizer(() => status("stopped").pipe(Effect.orDie));
    const run = Effect.scoped(
      Effect.gen(function* () {
        const child = yield* processes.spawn(
          ChildProcess.make(
            path.join(bundle, executable),
            [path.join(bundle, "src/executor-server.ts")],
            {
              cwd: directory,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              extendEnv: false,
              env: {
                MOTEL_OTEL_BASE_URL: url,
                MOTEL_OTEL_HOST: "127.0.0.1",
                MOTEL_OTEL_DB_PATH: path.join(directory, "telemetry.sqlite"),
                XDG_STATE_HOME: directory,
                MOTEL_OTEL_RETENTION_HOURS: "168",
                MOTEL_OTEL_MAX_DB_SIZE_MB: "1024",
              },
              killSignal: "SIGTERM",
              forceKillAfter: 3_000,
            },
          ),
        );
        pid = child.pid;
        const started = yield* Deferred.make<void>();
        yield* child.stderr.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.logInfo(line).pipe(Effect.annotateLogs({ process: "motel" })),
          ),
          Effect.forkScoped,
        );
        yield* child.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(Ready))(line).pipe(
              Effect.flatMap((ready) =>
                Effect.gen(function* () {
                  url = ready.url;
                  yield* status("running");
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.succeed(initial, url);
                  yield* Effect.logInfo("Local telemetry collector ready").pipe(
                    Effect.annotateLogs({ url }),
                  );
                }),
              ),
            ),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(started).pipe(
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
