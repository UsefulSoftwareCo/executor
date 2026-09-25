/** Billing's own database connection for jobs and billing routes. No identity or email fields leave it. */
import { PgClient } from "@effect/sql-pg";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { cloudDatabaseConnection } from "./database.ts";
import { BillingUnavailable } from "../contracts/billing.ts";

/** Run billing statements on one connection per invocation; any failure is BillingUnavailable. */
export const billingMembers = Effect.gen(function* () {
  const connection = yield* cloudDatabaseConnection;
  const sql = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        PgClient.layer({
          url: yield* connection.connectionString,
          maxConnections: 1,
          prepare: false,
        }),
      );
      return yield* SqlClient.SqlClient.pipe(Effect.provideContext(services));
    }),
  );
  const use = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    sql.pipe(
      Effect.flatMap((db) => Effect.provideService(effect, SqlClient.SqlClient, db)),
      Effect.provide(RuntimeContext.phantom),
      Effect.mapError(() => new BillingUnavailable()),
    );
  return { use };
});
