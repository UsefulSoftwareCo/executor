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
import { storageMigrationFailed } from "./storage-migration-error.ts";
import { makeToolSearchStore } from "./tool-search-store.ts";

const latestVersion = storageSchemas.at(-1)?.version;

export const makeExecutorStorage = (options: { readonly provider: SqlProvider }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* makeReactiveStore({ namespace: "executor" });
    const client = executorDatabase.client(sqlAdapter({ provider: options.provider }));
    const db = bindOrm(client.orm("4.0.18"), sql, reactivity);
    const checkMigration = Effect.gen(function* () {
      const migrator = yield* client.createMigrator;
      const version = yield* migrator.version;
      if (Option.isNone(version)) return;
      if (!storageSchemas.some((entry) => entry.version === version.value))
        return yield* new StorageError();
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError((cause) => storageMigrationFailed(cause)),
    );
    const upgrade = (stopAt: ReadonlySet<string>) =>
      Effect.gen(function* () {
        yield* checkMigration;
        const migrator = yield* client.createMigrator;
        const version = yield* migrator.version;
        if (Option.isNone(version)) {
          yield* Effect.gen(function* () {
            yield* (yield* migrator.migrateToLatest()).execute;
            yield* Effect.forEach(currentIndexes, (statement) => sql.unsafe(statement).unprepared, {
              discard: true,
            });
          }).pipe(Effect.mapError((cause) => storageMigrationFailed(cause, latestVersion)));
          return;
        }
        const current = storageSchemas.findIndex((entry) => entry.version === version.value);
        for (const entry of storageSchemas.slice(current + 1)) {
          if (stopAt.has(entry.version)) return;
          yield* Effect.gen(function* () {
            yield* (yield* migrator.up()).execute;
          }).pipe(Effect.mapError((cause) => storageMigrationFailed(cause, entry.version)));
        }
      }).pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((cause) => storageMigrationFailed(cause)),
      );
    const migrateTables = upgrade(trailingStorageIndexVersions);
    const migrate = upgrade(new Set());
    const version = Effect.gen(function* () {
      const migrator = yield* client.createMigrator;
      return Option.getOrUndefined(yield* migrator.version);
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(() => new StorageError()),
    );
    return {
      orm: (_version: "4.0.18") => db,
      reactivity,
      toolSearch: makeToolSearchStore(sql),
      checkMigration,
      migrateTables,
      migrate,
      version,
    };
  });
export type ExecutorDatabase = Effect.Success<ReturnType<typeof makeExecutorStorage>>;
