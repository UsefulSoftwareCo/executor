import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, type Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { AutumnClient, type AutumnOptions } from "../contracts/autumn.ts";
import { V1Membership, V1MembershipUnavailable } from "../contracts/onboarding.ts";
import { autumnLive } from "./autumn-client.ts";

/** Only the fields the decision reads; the rest of each WorkOS record is never decoded or kept. */
const Users = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const Memberships = Schema.Struct({
  data: Schema.Array(Schema.Struct({ organization_id: Schema.String, status: Schema.String })),
});
const Tenants = Schema.Array(Schema.Struct({ tenant: Schema.String }));

/** v1's plans that cost nothing. Every other plan, including ones added later, is paid. */
const freePlans: ReadonlyArray<string> = ["free", "free-pay-as-you-go"];

/** v1's WorkOS environment, its database and billing, and the moment the check shipped. */
export interface V1MembershipSettings {
  /** WorkOS API origin, or an emulator instance in tests. */
  readonly baseUrl: string;
  readonly key: Redacted.Redacted<string>;
  /** Accounts created before this instant used v2 before the check existed and skip it. */
  readonly since: Date;
  /** v1's Postgres, read through a role that can only select the tables below. */
  readonly database: Redacted.Redacted<string>;
  /** The Autumn account that bills v1, where each customer id is a WorkOS organization id. */
  readonly billing: AutumnOptions;
}

/** Self-host, local Cloud and test stages without v1's key admit every account. */
export const v1MembershipDisabled = Layer.succeed(
  V1Membership,
  V1Membership.of({ check: () => Effect.succeed("continue") }),
);

/**
 * Reads v1's WorkOS with two list calls: the user with this email, then that user's active
 * organization memberships. An organization keeps its member on v1 only when it has data in v1
 * or a paid v1 plan; an empty free organization is ignored, so an account whose every v1
 * organization is empty and free continues to v2. One query asks v1's database which of the
 * organizations have data; Autumn is asked only about the rest. Every failure is
 * `V1MembershipUnavailable`, never "continue". Emails, organization ids and responses never
 * enter errors, logs or spans.
 */
export const v1MembershipLive = (settings: V1MembershipSettings) =>
  Layer.effect(
    V1Membership,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl(settings.baseUrl),
            HttpClientRequest.bearerToken(settings.key),
            HttpClientRequest.acceptJson,
          ),
        ),
        HttpClient.filterStatusOk,
      );
      const autumn = AutumnClient.pipe(
        Effect.provide(autumnLive(settings.billing)),
        Effect.provideService(HttpClient.HttpClient, yield* HttpClient.HttpClient),
      );
      const list = <S extends Schema.Top>(
        path: string,
        params: Record<string, string>,
        schema: S,
      ) =>
        client
          .execute(HttpClientRequest.get(path).pipe(HttpClientRequest.setUrlParams(params)))
          .pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          );
      /** The v1 organizations this email is an active member of. */
      const organizations = (email: string) =>
        Effect.gen(function* () {
          const users = yield* list("/user_management/users", { email }, Users);
          const found = new Set<string>();
          // WorkOS emails are unique, so this is at most one user.
          for (const user of users.data) {
            const memberships = yield* list(
              "/user_management/organization_memberships",
              { user_id: user.id, statuses: "active", limit: "100" },
              Memberships,
            );
            for (const membership of memberships.data)
              if (membership.status === "active") found.add(membership.organization_id);
          }
          return [...found];
        });
      /** Whether any of these organizations has a row in a v1 table that holds its data. */
      const anyHasData = (ids: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          const rows = yield* sql`
            select organization.id as tenant
            from unnest(${ids}::text[]) as organization(id)
            where exists (select 1 from integration where tenant = organization.id)
              or exists (select 1 from connection where tenant = organization.id)
              or exists (select 1 from oauth_client where tenant = organization.id)
              or exists (select 1 from tool_policy where tenant = organization.id)
              or exists (select 1 from artifact where tenant = organization.id)
              or exists (
                select 1 from plugin_storage
                where tenant = organization.id and plugin_id = 'toolkits'
              )
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tenants)));
          return rows.length > 0;
        }).pipe(
          Effect.provide(
            PgClient.layer({
              url: settings.database,
              maxConnections: 1,
              prepare: false,
              connectTimeout: "5 seconds",
            }),
          ),
        );
      /** Whether Autumn bills this organization on a paid v1 plan. No customer means free. */
      const paid = (id: string) =>
        autumn.pipe(
          Effect.flatMap((billing) => billing.getCustomer({ customerId: id })),
          Effect.map(
            (customer) =>
              customer !== null &&
              customer.subscriptions.some(
                (subscription) =>
                  !freePlans.includes(subscription.planId) && subscription.status !== "expired",
              ),
          ),
        );
      const onV1 = (email: string) =>
        Effect.gen(function* () {
          const ids = yield* organizations(email);
          if (ids.length === 0) return false;
          if (yield* anyHasData(ids)) return true;
          const plans = yield* Effect.forEach(ids, paid, { concurrency: 4 });
          return plans.some((isPaid) => isPaid);
        });
      return V1Membership.of({
        check: (account) =>
          account.createdAt < settings.since
            ? Effect.succeed("continue")
            : onV1(account.email).pipe(
                Effect.timeout("10 seconds"),
                Effect.map((found) => (found ? ("v1" as const) : ("continue" as const))),
                Effect.tapError(() => Effect.logWarning("v1 membership check unavailable")),
                Effect.mapError(() => new V1MembershipUnavailable()),
                Effect.withSpan("onboarding.v1Membership"),
              ),
      });
    }),
  );
