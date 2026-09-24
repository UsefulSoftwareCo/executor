/** Trusted Node adapter. Each cache transaction opens and closes its own SQLite handle. */
import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Path, Schema } from "effect";
import { cacheKey, CacheError, CacheReply } from "@executor-js/app-cache";
import { sqliteCache } from "@executor-js/app-cache/sqlite";
import { isolatedCacheSession } from "apps/host";

/** Bind persistent storage to an app/build; refreshes are bounded and owned by the returned session. */
export const nodeCacheSession = (directory: string, app: string, build: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appKey = yield* cacheKey(app);
    const root = path.join(directory, "cache");
    yield* fs
      .makeDirectory(root, { recursive: true })
      .pipe(Effect.mapError(() => new CacheError({ reason: "storage" })));
    const filename = path.join(root, `${appKey}.sqlite`);
    return isolatedCacheSession((command) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const db = yield* Effect.acquireRelease(
              Effect.try({
                try: () => new DatabaseSync(filename),
                catch: () => new CacheError({ reason: "storage" }),
              }),
              (db) => Effect.sync(() => db.close()),
            );
            db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
            const cache = sqliteCache({
              sql: {
                exec: (query, ...bindings) => {
                  const rows = db.prepare(query).all(...bindings);
                  return {
                    toArray: () => rows,
                    one: () => {
                      if (rows.length !== 1) throw new Error("Expected one SQL result");
                      return rows[0];
                    },
                  };
                },
              },
              transactionSync: (work) => {
                db.exec("BEGIN IMMEDIATE");
                try {
                  const result = work();
                  db.exec("COMMIT");
                  return result;
                } catch (error) {
                  db.exec("ROLLBACK");
                  throw error;
                }
              },
            });
            return yield* cache(build, command);
          }),
        ).pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (error) => ({ ok: false as const, error }),
          }),
          Effect.flatMap(Schema.encodeEffect(CacheReply)),
        ),
      ),
    );
  });
