/** The local server's PGlite databases, each created whole before it is first opened. */
import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase, pgliteLayer } from "fumadb-effect/pglite";
import { Effect, Layer, Schema } from "effect";
import { LocalDatabaseName, StartupCode, StartupFailed } from "../contracts/startup.ts";

/**
 * Each database is its own Postgres with its own WebAssembly memory, and Postgres's default 128 MB
 * buffer pool is allocated in that memory up front. Local databases are small and their files stay
 * in the OS page cache, so a 16 MB pool keeps reads fast while the three databases together hold
 * about 350 MB less of the process.
 */
const startParams = [...PGlite.defaultStartParams, "-c", "shared_buffers=16MB"];

/**
 * Open one of the local server's PGlite databases, creating it whole first if needed (see
 * `persistentPgliteLayer`). The caller holds the data directory's lock. A creation that fails
 * names the database and the step that failed, whichever startup stage opens it.
 */
export const localDatabase = (dataDir: string) =>
  Layer.unwrap(
    createPgliteDatabase(dataDir, { startParams }).pipe(
      Effect.mapError(
        (error) =>
          new StartupFailed({
            stage: "database",
            ...(Schema.is(LocalDatabaseName)(error.database) ? { database: error.database } : {}),
            step: error.step,
            ...(Schema.is(StartupCode)(error.code) ? { code: error.code } : {}),
          }),
      ),
      Effect.as(pgliteLayer({ dataDir, startParams })),
    ),
  );
