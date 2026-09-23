/** Node/desktop/Docker adapter. Each configured app owns a durable SQLite file. */
import * as Sqlite from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, FileSystem, Path, ScopedCache } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import type { ReactiveStore } from "@executor-js/reactivity";
import {
  AppDatabaseError,
  defaultDatabaseRuntimeLimits,
  type AppDatabases,
} from "./contracts/database.ts";
import { makeSqliteDatabase } from "./implementation/sqlite.ts";
import { fingerprint } from "./implementation/cursor.ts";

/** Acquire a bounded connection cache. Active invocation scopes retain their connection until completion. */
export const filesystemAppDatabases = (options: {
  readonly directory: string;
  readonly reactivity: ReactiveStore;
  readonly crypto: Crypto;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs
      .makeDirectory(options.directory, { recursive: true })
      .pipe(Effect.mapError(() => new AppDatabaseError({ reason: "storage" })));
    const cache = yield* ScopedCache.make({
      capacity: defaultDatabaseRuntimeLimits.connectionCacheCapacity,
      timeToLive: defaultDatabaseRuntimeLimits.connectionCacheTtlMs,
      lookup: (app: string) =>
        Effect.gen(function* () {
          const filename = yield* fingerprint(options.crypto, app);
          return yield* Sqlite.make({
            filename: path.join(options.directory, `${filename}.sqlite`),
          });
        }).pipe(Effect.provide(Reactivity.layer)),
    });
    const run = <A, E>(
      write: boolean,
      app: string,
      schema: Parameters<AppDatabases["read"]>[1],
      work: (session: import("./contracts/database.ts").DatabaseSession) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* ScopedCache.get(cache, app);
          const db = yield* makeSqliteDatabase({ sql, schema, crypto: options.crypto });
          const operation = db[write ? "mutate" : "read"]((session) =>
            work(session).pipe(
              // Notification publication masks interruption after commit. Restore it
              // for the author body so timeout/cancellation rolls back the SQL work.
              Effect.interruptible,
              Effect.tap(() => {
                const keys = [...session.readTables].map((table) =>
                  JSON.stringify(["app-data", app, table]),
                );
                const writes = [...session.changedTables].map((table) =>
                  JSON.stringify(["app-data", app, table]),
                );
                return options.reactivity.read(
                  keys,
                  write ? options.reactivity.write(writes, Effect.void) : Effect.void,
                );
              }),
            ),
          );
          return yield* write ? options.reactivity.transaction(operation) : operation;
        }),
      );
    return {
      read: (app, schema, work) => run(false, app, schema, work),
      mutate: (app, schema, work) => run(true, app, schema, work),
    } satisfies AppDatabases;
  });
