/** Runtime storage and the explicit, transactional migration boundary. */
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { sqlAdapter } from "fumadb-effect/sql";
import type { Provider as SqlProvider } from "fumadb-effect";
import { makeReactiveStore } from "@executor-js/reactivity";
import { StorageError } from "../contracts/shared.ts";
import { bindOrm } from "./reactive-orm.ts";
import {
  currentIndexes,
  executorDatabase,
  storageSchemas,
  trailingStorageIndexVersions,
} from "./storage-migrations.ts";
import { makeToolSearchStore } from "./tool-search-store.ts";

/** Capture caller-owned SQL. Migrations accept only fresh or supported version 4 databases. */
export const makeExecutorStorage = (options: { readonly provider: SqlProvider }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* makeReactiveStore({ namespace: "executor" });
    const client = executorDatabase.client(sqlAdapter({ provider: options.provider }));
    const db = bindOrm(client.orm("4.0.23"), sql, reactivity);
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
    const upgrade = (stopAt: ReadonlySet<string>) =>
      Effect.gen(function* () {
        yield* checkMigration;
        const migrator = yield* client.createMigrator;
        const version = yield* migrator.version;
        if (Option.isNone(version)) {
          // A new database needs the current layout and all of its indexes, not
          // historical data conversions. FumaDB's direct diff omits custom steps.
          // Its tables are empty, so no index build waits on or blocks a writer.
          yield* (yield* migrator.migrateToLatest()).execute;
          yield* Effect.forEach(currentIndexes, (statement) => sql.unsafe(statement).unprepared, {
            discard: true,
          });
          return;
        }
        // Execute every registered upgrade in order. A direct diff to latest can skip
        // an intermediate guard, data conversion, or custom index operation. The pending
        // versions are known here, so nothing reads the database after the last upgrade.
        const current = storageSchemas.findIndex((entry) => entry.version === version.value);
        for (const entry of storageSchemas.slice(current + 1)) {
          if (stopAt.has(entry.version)) return;
          yield* (yield* migrator.up()).execute;
        }
      }).pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(() => new StorageError()),
      );
    /** Every upgrade except the trailing index-only versions, which `migrate` then runs. */
    const migrateTables = upgrade(trailingStorageIndexVersions);
    const migrate = upgrade(new Set());
    /** The version the database records; none before its first migration. */
    const version = Effect.gen(function* () {
      const migrator = yield* client.createMigrator;
      return Option.getOrUndefined(yield* migrator.version);
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(() => new StorageError()),
    );
    return {
      orm: (_version: "4.0.23") => db,
      reactivity,
      // Search rows are derived data no reactive reader watches, ranked by SQL the ORM cannot express.
      toolSearch: makeToolSearchStore(sql),
      checkMigration,
      migrateTables,
      migrate,
      version,
    };
  });
/** Caller-owned, Effect-native persistence with commit-driven subscriptions. */
export type ExecutorDatabase = Effect.Success<ReturnType<typeof makeExecutorStorage>>;
