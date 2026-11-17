/** Effect owns the bundled telemetry collector process and restarts it after unexpected exits. */
import { Deferred, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The collector's one line on stdout, once it accepts connections on its TCP port. */
const Listening = Schema.Struct({
  event: Schema.Literal("listening"),
  port: Schema.Number.check(
    Schema.makeFilter((port) => Number.isInteger(port) && port > 0 && port < 65_536),
  ),
});

/**
 * The bounds a local host gives its collector: the ones it gave Motel, a week of telemetry in at
 * most 1 GiB and exports of at most 16 MiB, and four exports at once.
 */
const bounds = [
  "--retention-hours=168",
  "--max-store-mb=1024",
  "--max-export-bytes=16777216",
  "--max-pending=4",
];

/** Where a build of this package keeps the collector and the viewer it serves. */
export interface CollectorFiles {
  /** The `executor-collector` executable. */
  readonly executable: string;
  /** The viewer's build, served at the collector's origin root. */
  readonly viewer: string;
}

/**
 * Serve the collector on loopback. Port 0 binds any free port, which the collector reports in its
 * listening line.
 */
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
          // A process's working directory cannot be removed or renamed on Windows. The collector
          // can outlive the parent's reported exit while it terminates, so it never runs inside data.
          cwd: path.dirname(files.executable),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          // The collector does not watch its parent. It shares the parent's process group on POSIX
          // and Node's kill-on-close job on Windows, so stopping the parent also stops it.
          detached: false,
          // It stops within 2.5 seconds of SIGTERM, keeping every export it acknowledged.
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

/** Start supervision immediately; only exports await the collector's first ready address. */
export const startCollector = (directory: string, files: CollectorFiles) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const initial = yield* Deferred.make<string>();
    const statusPath = path.join(directory, "collector.json");
    const data = path.join(directory, "collector");
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
        const { child, listening } = yield* serveCollector(files, data, port);
        pid = child.pid;
        // Its own log: JSON lines on stderr.
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
