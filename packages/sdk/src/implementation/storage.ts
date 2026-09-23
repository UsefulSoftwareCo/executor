/** Runtime storage and the explicit, transactional migration boundary. */
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { sqlAdapter } from "fumadb-effect/sql";
import type { Provider as SqlProvider } from "fumadb-effect";
import { makeReactiveStore } from "@executor-js/reactivity";
import { StorageError } from "../contracts/shared.ts";
import { bindOrm } from "./reactive-orm.ts";
import { executorDatabase, storageIndexes, storageSchemas } from "./storage-migrations.ts";

/** Capture caller-owned SQL. Migrations accept only fresh or supported version 4 databases. */
export const makeExecutorStorage = (options: { readonly provider: SqlProvider }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* makeReactiveStore({ namespace: "executor" });
    const client = executorDatabase.client(sqlAdapter({ provider: options.provider }));
    const db = bindOrm(client.orm("4.0.0"), sql, reactivity);
    const checkMigration = Effect.gen(function* () {
      const migrator = yield* client.createMigrator;
      const version = yield* migrator.version;
      if (Option.isNone(version)) return;
      if (!storageSchemas.some((entry) => entry.version === version.value))
        return yield* new StorageError();
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(() => new StorageError()),
    );
    const migrate = Effect.gen(function* () {
      yield* checkMigration;
      const migrator = yield* client.createMigrator;
      const version = yield* migrator.version;
      if (Option.isNone(version)) {
        // A new database needs the current layout and all of its indexes, not
        // historical data conversions. FumaDB's direct diff omits custom steps.
        yield* (yield* migrator.migrateToLatest()).execute;
        yield* Effect.forEach(storageIndexes, (statement) => sql.unsafe(statement).unprepared, {
          discard: true,
        });
      } else {
        // Execute every registered upgrade. A direct diff to latest can skip
        // an intermediate guard, data conversion, or custom index operation.
        while (Option.isSome(yield* migrator.next)) yield* (yield* migrator.up()).execute;
      }
    }).pipe(
      sql.withTransaction,
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(() => new StorageError()),
    );
    return { orm: (_version: "4.0.0") => db, reactivity, checkMigration, migrate };
  });
/** Caller-owned, Effect-native persistence with commit-driven subscriptions. */
export type ExecutorDatabase = Effect.Success<ReturnType<typeof makeExecutorStorage>>;
