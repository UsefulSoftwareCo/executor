import { PGlite } from "@electric-sql/pglite";
import { createPgliteDatabase, pgliteLayer } from "fumadb-effect/pglite";
import { Effect, Layer, Schema } from "effect";
import { LocalDatabaseName, StartupCode, StartupFailed } from "../contracts/startup.ts";

const startParams = [...PGlite.defaultStartParams, "-c", "shared_buffers=16MB"];

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
