/**
 * A server started by the CLI records its process, version and command in its data directory while
 * it runs, so `executor upgrade` can say that it still runs the old version and how to restart it.
 */
import { Effect, FileSystem, Option, Path, Schema } from "effect";

export const ServerRecord = Schema.Struct({
  pid: Schema.Number,
  /** The release the server runs; none for development and commit builds. */
  version: Schema.optional(Schema.String),
  url: Schema.String,
  command: Schema.Literals(["executor", "executor serve"]),
});
export type ServerRecord = typeof ServerRecord.Type;
const ServerRecordJson = Schema.fromJsonString(ServerRecord);

const recordFile = (directory: string) =>
  Effect.map(Path.Path, (path) => path.join(directory, "server.json"));

/** Keep `record` in the data directory for the current scope. Writing it never stops startup. */
export const recordServer = (directory: string, record: ServerRecord) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* recordFile(directory);
    yield* Effect.acquireRelease(
      fs.writeFileString(file, Schema.encodeSync(ServerRecordJson)(record)).pipe(Effect.ignore),
      () => fs.remove(file, { force: true }).pipe(Effect.ignore),
    );
  });

/** Signal 0 checks that a process exists; EPERM means it exists under another user. */
const processExists = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      Effect.succeed(
        Schema.is(Schema.Struct({ cause: Schema.Struct({ code: Schema.Literal("EPERM") }) }))(
          error,
        ),
      ),
    ),
  );

/** The server recorded in `directory` if its process is still running. */
export const runningServer = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const saved = yield* fs
      .readFileString(yield* recordFile(directory))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ServerRecordJson)), Effect.option);
    if (Option.isNone(saved)) return undefined;
    return (yield* processExists(saved.value.pid)) ? saved.value : undefined;
  });
