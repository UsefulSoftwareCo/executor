/** One persisted PGlite engine for self-host auth and product data. */
import { selfHostAuthOptions, selfHostAuthSettings } from "./implementation/auth-options.ts";
import { migrateHostedSchemas } from "@executor-js/hosted-server/migrations";
import { Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { lock } from "proper-lockfile";
import { dataDirectory } from "./contracts/config.ts";
import { AuthDatabase, DatabaseUnavailable } from "./contracts/database.ts";
import { makeAuthDatabase } from "./implementation/auth-database.ts";

const databaseDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configured = yield* dataDirectory;
  const directory = path.resolve(configured, "hosted.pglite");
  yield* fs
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(() => new DatabaseUnavailable({ stage: "directory" })));
  yield* fs
    .chmod(directory, 0o700)
    .pipe(Effect.mapError(() => new DatabaseUnavailable({ stage: "directory" })));
  // Heartbeat lock recovers after a crash, while rejecting concurrent processes.
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => lock(directory, { retries: 0 }),
      catch: () => new DatabaseUnavailable({ stage: "lock" }),
    }),
    (unlock) => Effect.promise(() => unlock()),
  );
  return directory;
});

/** Acquire one engine and initialize both schemas before exposing services. */
export const selfHostDatabase = Layer.effect(
  AuthDatabase,
  Effect.gen(function* () {
    const db = yield* makeAuthDatabase;
    const database = AuthDatabase.of({ db, type: "postgres", transaction: true });
    const settings = yield* selfHostAuthSettings;
    yield* migrateHostedSchemas({
      ...selfHostAuthOptions(settings, []),
      database,
      secret: Redacted.value(settings.secret),
    });
    return database;
  }),
).pipe(
  Layer.provideMerge(
    Layer.unwrap(Effect.map(databaseDirectory, (dataDir) => pgliteLayer({ dataDir }))),
  ),
);
