/** Request-owned database reads for billing. No identity or email fields leave this adapter. */
import { PgClient } from "@effect/sql-pg";
import { OrganizationId } from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, Schema } from "effect";
import { DatabaseConnection } from "./database.ts";
import { BillingUnavailable } from "../contracts/billing.ts";

const Counts = Schema.Array(
  Schema.Struct({ organization: OrganizationId, count: Schema.NumberFromString }),
);
/** Each read takes a fresh authoritative member count; pending invitations are not seats. */
export const billingMembers = Effect.gen(function* () {
  const connection = yield* Cloudflare.Hyperdrive.Connect(yield* DatabaseConnection);
  const sql = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        PgClient.layer({
          url: yield* connection.connectionString,
          maxConnections: 1,
          prepare: false,
        }),
      );
      return yield* PgClient.PgClient.pipe(Effect.provideContext(services));
    }),
  );
  const read = (organization?: OrganizationId) =>
    Effect.gen(function* () {
      const db = yield* sql;
      const rows =
        organization === undefined
          ? yield* db`select o.id as organization, count(m.id)::text as count from organization o left join member m on m."organizationId" = o.id group by o.id`
          : yield* db`select o.id as organization, count(m.id)::text as count from organization o left join member m on m."organizationId" = o.id where o.id = ${organization} group by o.id`;
      return yield* Schema.decodeUnknownEffect(Counts)(rows);
    }).pipe(
      Effect.provide(RuntimeContext.phantom),
      Effect.mapError(() => new BillingUnavailable()),
    );
  return { read };
}).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding));
