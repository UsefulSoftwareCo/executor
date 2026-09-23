/** One persisted PGlite engine for self-host auth and product data. */
import { Effect, FileSystem, Layer, Path } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { lock } from "proper-lockfile";
import { dataDirectory } from "./contracts/config.ts";
import { DatabaseUnavailable } from "./contracts/database.ts";
import { selfHostDatabaseSchema } from "./implementation/database-schema.ts";

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

/** Acquire the native engine before exposing migrated auth and product services. */
export const selfHostDatabase = selfHostDatabaseSchema.pipe(
  Layer.provideMerge(
    Layer.unwrap(Effect.map(databaseDirectory, (dataDir) => pgliteLayer({ dataDir }))),
  ),
);
