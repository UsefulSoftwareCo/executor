/** Local PGlite driver composition and additive schema setup. */
import { makeExecutorStorage } from "@executor-js/sdk/core";
import { createDataStepJournal } from "@executor-js/app-management/data-steps";
import { startupPhase } from "./startup-diagnostics.ts";
import { pgliteLayer } from "fumadb-effect/pglite";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";
import * as Migrator from "effect/sql/Migrator";

/**
 * Local product tables beside the SDK schema, each applied once and recorded in the same SQL
 * transaction. Append new steps; never change one that has shipped.
 */
const migrateLocalProduct = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Effect's Postgres migrator probes with ::regclass; create its journal explicitly first.
  yield* sql`create table if not exists private_local_migrations (
    migration_id integer primary key,
    created_at timestamp with time zone not null default now(),
    name text not null
  )`;
  yield* Migrator.make({})({
    table: "private_local_migrations",
    loader: Migrator.fromRecord({ "1_data_steps": createDataStepJournal("private_local") }),
  });
});

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
    yield* migrateLocalProduct.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return { storage, sql };
  }).pipe(startupPhase("storage"));
