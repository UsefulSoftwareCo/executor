/** Local PGlite driver composition and additive schema setup. */
import { makeExecutorStorage } from "@executor-js/sdk/core";
import { startupPhase } from "./startup-diagnostics.ts";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Open persistent Effect SQL resources in the host scope and preserve existing records. */
export const openStorage = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const location = path.join(directory, "executor.pglite");
    yield* fs.makeDirectory(location, { recursive: true, mode: 0o700 });
    yield* fs.chmod(location, 0o700);
    const context = yield* Layer.build(pgliteLayer({ dataDir: location }));
    const sql = Context.get(context, SqlClient.SqlClient);
    const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    yield* storage.migrate;
    return storage;
  }).pipe(startupPhase("storage"));
