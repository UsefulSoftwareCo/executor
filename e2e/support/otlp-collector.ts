/** Run the shipped collector as a separate process; query only its public HTTP API. */
import { Deferred, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const Ready = Schema.Struct({ version: Schema.Literal(1), url: Schema.String });

/** Each managed Cloud target owns an isolated on-disk collector and its lifetime. */
export const startOtlpCollector = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const diagnostics = path.join(directory, "data/diagnostics");
    yield* fs.makeDirectory(diagnostics, { recursive: true });
    const built = yield* processes.exitCode(
      ChildProcess.make("bun", ["run", "telemetry:build"], {
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (built !== 0) return yield* Effect.die("Could not build the shipped telemetry collector");
    const bundle = path.resolve("packages/telemetry/dist/motel");
    const ready = yield* Deferred.make<string>();
    const child = yield* processes.spawn(
      ChildProcess.make(
        path.join(bundle, process.platform === "win32" ? "bun.exe" : "bun"),
        [path.join(bundle, "src/executor-server.ts")],
        {
          cwd: diagnostics,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: false,
          env: {
            MOTEL_OTEL_BASE_URL: "http://127.0.0.1:0",
            MOTEL_OTEL_HOST: "127.0.0.1",
            MOTEL_OTEL_DB_PATH: path.join(diagnostics, "telemetry.sqlite"),
            XDG_STATE_HOME: diagnostics,
            MOTEL_OTEL_RETENTION_HOURS: "168",
          },
          forceKillAfter: "3 seconds",
        },
      ),
    );
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Ready))(line).pipe(
          Effect.flatMap(({ url }) => Deferred.succeed(ready, url)),
          Effect.asVoid,
        ),
      ),
      Effect.forkScoped,
    );
    yield* child.stderr.pipe(
      Stream.decodeText,
      Stream.runForEach((text) =>
        fs.writeFileString(path.join(directory, "collector.log"), text, { flag: "a", mode: 0o600 }),
      ),
      Effect.forkScoped,
    );
    const url = yield* Deferred.await(ready).pipe(Effect.timeout("20 seconds"));
    yield* fs.writeFileString(
      path.join(diagnostics, "collector.json"),
      JSON.stringify({ state: "running", url }),
      { mode: 0o600 },
    );
    return url;
  });
