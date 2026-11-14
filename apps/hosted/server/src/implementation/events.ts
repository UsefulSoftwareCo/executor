/**
 * Hosted event authority. Before each delivery the subscriber must still hold the grant or
 * personal access token that subscribed, that grant must still include the app's events, and its
 * user must still be a member who may use the app. An occurrence whose invocation used an account
 * the user may not use is dropped; the subscription continues for the others. A subscription to a
 * selection of several events or apps loses none of them when one fails the app or event checks:
 * that occurrence is dropped instead.
 */
import { GrantPolicy, grantEventAccess } from "@executor-js/mcp-auth";
import { ConnectionPolicy, connectionGrantPolicy } from "@executor-js/mcp-auth/connections";
import {
  EventAccessRevoked,
  EventNotVisible,
  StorageError,
  type EventDeliveryAuthority,
} from "@executor-js/sdk/core";
import { Clock, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { GroupDatabase } from "../contracts/groups.ts";
import { OrganizationId, organizationOwner } from "../contracts/organization.ts";
import { patGrantOf } from "./mcp-oauth.ts";
import { ownedAccountIds, resourceAuthorityForApp } from "./resource-policy.ts";

const GrantRow = Schema.Struct({
  userId: Schema.String,
  resource: Schema.String,
  policy: Schema.String,
  revoked: Schema.Boolean,
  connection: Schema.NullOr(Schema.String),
  connectionPolicy: Schema.NullOr(Schema.String),
  connectionRevoked: Schema.NullOr(Schema.Boolean),
  connectionUser: Schema.NullOr(Schema.String),
  connectionResource: Schema.NullOr(Schema.String),
});
const KeyRow = Schema.Struct({
  userId: Schema.String,
  usable: Schema.Boolean,
  expiresAt: Schema.NullOr(Schema.Number),
});

/** The grant's user, organization and current policy, or none when it no longer stands. */
const grantStanding = (sql: SqlClient.SqlClient, id: string) =>
  Effect.gen(function* () {
    const pat = patGrantOf(id);
    if (Option.isSome(pat)) {
      const rows = yield* sql`select "referenceId" as "userId",
          enabled is not false and remaining is null as usable,
          floor(extract(epoch from "expiresAt") * 1000)::float8 as "expiresAt"
        from apikey where id = ${pat.value.token}`;
      const key = Schema.decodeUnknownOption(KeyRow)(rows[0]);
      if (Option.isNone(key) || !key.value.usable) return Option.none();
      const expiresAt = key.value.expiresAt;
      if (expiresAt !== null && (yield* Clock.currentTimeMillis) > expiresAt) return Option.none();
      return Option.some({
        userId: key.value.userId,
        organization: pat.value.organization,
        policy: GrantPolicy.make({ kind: "all" }),
      });
    }
    const rows = yield* sql`select g."userId" as "userId", g.resource, g.policy, g.revoked,
        g.connection, mc.policy as "connectionPolicy", mc.revoked as "connectionRevoked",
        mc."userId" as "connectionUser", mc.resource as "connectionResource"
      from "mcpGrant" g left join "mcpConnection" mc on mc.id = g.connection
      where g.id = ${id}`;
    const grant = Schema.decodeUnknownOption(GrantRow)(rows[0]);
    if (Option.isNone(grant) || grant.value.revoked) return Option.none();
    const row = grant.value;
    const organization = Schema.decodeUnknownOption(OrganizationId)(row.resource);
    if (Option.isNone(organization)) return Option.none();
    // A connection grant has no authority of its own; it reads the connection's.
    const policy =
      row.connection === null
        ? Schema.decodeUnknownOption(Schema.fromJsonString(GrantPolicy))(row.policy)
        : row.connectionRevoked !== false ||
            row.connectionUser !== row.userId ||
            row.connectionResource !== row.resource
          ? Option.none()
          : Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionPolicy))(
              row.connectionPolicy,
            ).pipe(Option.map(connectionGrantPolicy));
    return Option.map(policy, (policy) => ({
      userId: row.userId,
      organization: organization.value,
      policy,
    }));
  }).pipe(Effect.catchTag("SqlError", () => Effect.fail(new StorageError())));

/** Check one delivery. The database is the event's own; nothing is retained across calls. */
export const hostedEventAuthority =
  (database: Effect.Effect<SqlClient.SqlClient, StorageError>) =>
  ({ subscription, app: source, event, accounts }: EventDeliveryAuthority) =>
    Effect.gen(function* () {
      const sql = yield* database;
      const standing = yield* grantStanding(sql, subscription.principal);
      if (
        Option.isNone(standing) ||
        standing.value.userId !== subscription.subject ||
        organizationOwner(standing.value.organization) !== subscription.owner
      )
        return yield* new EventAccessRevoked();
      // A selection outlives any one app or event it covers; a single event does not.
      const selected = subscription.app === null || subscription.event === null;
      const refused = () =>
        selected ? Effect.fail(new EventNotVisible()) : Effect.fail(new EventAccessRevoked());
      const access = grantEventAccess(standing.value.policy, source, event);
      if (access === undefined) return yield* refused();
      const { actor, access: app } = yield* resourceAuthorityForApp(
        standing.value.organization,
        standing.value.userId,
        source,
      ).pipe(Effect.catchTag("OrganizationForbidden", () => Effect.fail(new EventAccessRevoked())));
      if (!app.canUse) return yield* refused();
      // The event may carry data from any account its invocation used, not only its source.
      const owned = yield* ownedAccountIds([...new Set(accounts)], actor);
      for (const account of accounts) if (!owned.has(account)) return yield* new EventNotVisible();
      // A grant limited to some accounts receives only occurrences that use no others.
      return access;
    }).pipe(
      Effect.provideService(GroupDatabase, database.pipe(Effect.orDie)),
      Effect.withSpan("hosted.events.authorize"),
    );
