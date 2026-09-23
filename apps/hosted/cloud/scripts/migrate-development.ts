/** Wait for the local database, then run the real hosted migrations before serving traffic. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { PgClient } from "@effect/sql-pg";
import { Config, Effect, Schedule, Schema } from "effect";
import { LocalDatabaseUrl } from "../src/contracts/database.ts";
import { migrateCloudDatabase } from "../src/implementation/migrations.ts";

class DevelopmentDatabaseUnavailable extends Schema.TaggedError<DevelopmentDatabaseUnavailable>()(
  "DevelopmentDatabaseUnavailable",
  {},
) {}

NodeRuntime.runMain(
  Effect.gen(function* () {
    const url = yield* Config.Redacted("DATABASE_URL").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(LocalDatabaseUrl)),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        yield* sql`SELECT 1`.pipe(
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
        );
      }).pipe(
        Effect.provide(PgClient.layer({ url, maxConnections: 1, connectTimeout: "2 seconds" })),
      ),
    ).pipe(Effect.mapError(() => new DevelopmentDatabaseUnavailable()));
    yield* migrateCloudDatabase;
  }),
);
