import { Deferred, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const Listening = Schema.Struct({
  event: Schema.Literal("listening"),
  port: Schema.Number.check(
    Schema.makeFilter((port) => Number.isInteger(port) && port > 0 && port < 65_536),
  ),
});

const bounds = [
  "--retention-hours=168",
  "--max-store-mb=1024",
  "--max-export-bytes=16777216",
  "--max-pending=4",
];

export interface CollectorFiles {
  readonly executable: string;
  readonly viewer: string;
}

const serveCollector = (files: CollectorFiles, data: string, port: number) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(
      ChildProcess.make(
        files.executable,
        [
          "serve",
          `--data=${data}`,
          `--listen=127.0.0.1:${port}`,
          `--viewer=${files.viewer}`,
          ...bounds,
        ],
        {
          cwd: path.dirname(files.executable),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: false,
          killSignal: "SIGTERM",
          forceKillAfter: 3_000,
        },
      ),
    );
    const listening = yield* Deferred.make<number>();
    yield* child.stdout.pipe(
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

export const startCollector = (directory: string, files: CollectorFiles) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const initial = yield* Deferred.make<string>();
    const statusPath = path.join(directory, "collector.json");
    const data = path.join(directory, "collector");
    yield* fs.makeDirectory(data, { recursive: true, mode: 0o700 });
    let pid: number | undefined;
    let port = 0;
    const url = () => `http://127.0.0.1:${port}`;
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
        const { child, listening } = yield* serveCollector(files, data, port);
        pid = child.pid;
        yield* child.stderr.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.logInfo(line).pipe(Effect.annotateLogs({ process: "collector" })),
          ),
          Effect.forkScoped,
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
