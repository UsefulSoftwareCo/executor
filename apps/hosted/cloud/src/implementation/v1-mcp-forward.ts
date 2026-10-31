/**
 * MCP requests v1 forwards for workspaces that moved to v2 (`notes/v1-import.md`, Forwarding).
 *
 * v1 keeps serving its MCP URLs and authenticating its own credentials (AuthKit tokens and WorkOS
 * API keys). For a moved organization it sends the request on to v2 with a bearer it signs with a
 * secret only v1 and v2 hold, naming the v1 account and organization, and for a toolkit URL the
 * toolkit and the v2 connection it was imported as:
 *
 *     v1fwd.<base64url JSON claims>.<base64url HMAC-SHA256 of "v1fwd.<claims>">
 *
 * This module turns that bearer into ordinary MCP access through the import map: the v1 account's
 * v2 user, the v1 organization's v2 organization, the user's live membership in it, and, for a
 * toolkit, the caller's own copy of it (decision 11), a scoped connection. Every request and every tool call checks it again, as a grant is
 * checked. Nothing here reads v1: what v1 vouches for is only who called and where.
 */
import {
  AuthenticationUnavailable,
  McpAccess,
  McpApprovalForbidden,
  McpForbidden,
  McpUnauthorized,
  OrganizationId,
  OrganizationRole,
  organizationOwner,
  type OrganizationReference,
} from "@executor-js/hosted-server";
import { ApprovalMode, GrantId, grantAuthorization, type GrantPolicy } from "@executor-js/mcp-auth";
import {
  ConnectionId,
  ConnectionPolicy,
  connectionGrantPolicy,
} from "@executor-js/mcp-auth/connections";
import { Clock, Effect, Option, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { SqlClient } from "effect/sql";
import { toolkitCopyConnectionId, toolkitCopyId } from "./v1-import/store.ts";

const prefix = "v1fwd.";

/** The client every forwarded request is attributed to, in usage and in its session's key. */
export const v1ForwardClient = "executor-v1";

/** v1 signs a bearer for one request and gives it ten minutes; one over fifteen is refused. */
const lifetimeSeconds = 900;

const Claims = Schema.Struct({
  v: Schema.Literal(1),
  /** The v1 account: a WorkOS user ID. */
  account: Schema.NonEmptyString,
  /** The v1 organization: a WorkOS organization ID. */
  organization: Schema.NonEmptyString,
  /** Expiry, in Unix seconds. */
  exp: Schema.Int,
  /** The v1 toolkit's row, for a toolkit URL. */
  toolkit: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * The v2 connection v1 computed for the caller's copy of the toolkit, which v1 also names in the
   * URL; it must name the copy the import made for this caller.
   */
  connection: Schema.optionalKey(ConnectionId),
});
type Claims = typeof Claims.Type;

const bearer = (headers: Headers) => headers.get("authorization")?.match(/^Bearer (\S+)$/iu)?.[1];

/** Whether the request presents a forwarded bearer, before any check. */
export const isV1Forward = (headers: Headers) => bearer(headers)?.startsWith(prefix) === true;

/**
 * The synthetic grant a forwarded request runs under. Its ID is stable for the user, organization,
 * URL mode and connection, so a session v2 opens for one forwarded request is found again by the
 * next, which presents a new bearer.
 */
const grantPrefix = "v1:";
const grantId = (input: {
  readonly user: string;
  readonly organization: string;
  readonly mode: ApprovalMode;
  readonly connection: string | undefined;
}) =>
  GrantId.make(
    `${grantPrefix}${encodeURIComponent(JSON.stringify([input.user, input.organization, input.mode, input.connection ?? null]))}`,
  );

const unauthorized = new McpUnauthorized();

/** The claims of a bearer v1 signed with `secret` that has not expired, or why not. */
const verify = (secret: Redacted.Redacted<string>, token: string) =>
  Effect.gen(function* () {
    const [, payload, signature, ...rest] = token.split(".");
    if (payload === undefined || signature === undefined || rest.length > 0)
      return yield* unauthorized;
    const mac = Base64Url.decode(signature);
    if (Result.isFailure(mac)) return yield* unauthorized;
    const valid = yield* Effect.tryPromise(async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        "HMAC",
        key,
        new Uint8Array(mac.success),
        new TextEncoder().encode(`${prefix}${payload}`),
      );
    }).pipe(Effect.orDie);
    if (!valid) return yield* unauthorized;
    const claims = yield* Base64Url.decodeString(payload).pipe(
      Result.match({
        onFailure: () => Effect.fail(unauthorized),
        onSuccess: (json) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Claims))(json).pipe(
            Effect.mapError(() => unauthorized),
          ),
      }),
    );
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    if (claims.exp < now || claims.exp > now + lifetimeSeconds) return yield* unauthorized;
    if ((claims.toolkit === undefined) !== (claims.connection === undefined))
      return yield* unauthorized;
    return claims;
  });

const Row = Schema.Struct({
  userId: Schema.NullOr(Schema.String),
  organization: Schema.NullOr(Schema.String),
  slug: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  toolkitConnection: Schema.NullOr(Schema.String),
  connectionUser: Schema.NullOr(Schema.String),
  connectionResource: Schema.NullOr(Schema.String),
  connectionPolicy: Schema.NullOr(Schema.String),
  connectionRevoked: Schema.NullOr(Schema.Boolean),
});

/** Everything one check reads, in one statement: the mapped user and organization and the rest. */
const load = (sql: SqlClient.SqlClient, claims: Claims) =>
  sql`
    with u as (
      select v2_id from private_v1_import_map
      where v1_kind = 'user' and v1_id = ${claims.account} and status = 'imported'
    ), o as (
      select v2_id from private_v1_import_map
      where v1_kind = 'organization' and v1_id = ${claims.organization} and status = 'imported'
    ), t as (
      select v2_id from private_v1_import_map
      where v1_kind = 'toolkit'
        and v1_id = ${claims.toolkit === undefined ? null : toolkitCopyId(claims.toolkit, claims.account)}
        and v1_org_id = ${claims.organization} and status = 'imported'
    )
    select
      (select v2_id from u) as "userId",
      (select v2_id from o) as organization,
      (select slug from organization where id = (select v2_id from o)) as slug,
      (select role from member
        where "userId" = (select v2_id from u) and "organizationId" = (select v2_id from o)) as role,
      (select v2_id from t) as "toolkitConnection",
      mc."userId" as "connectionUser",
      mc.resource as "connectionResource",
      mc.policy as "connectionPolicy",
      mc.revoked as "connectionRevoked"
    from (select 1) one
    left join "mcpConnection" mc on mc.id = (select v2_id from t)`.pipe(
    Effect.flatMap((rows) => Schema.decodeUnknownEffect(Row)(rows[0])),
  );

/** The connection a toolkit's grant reads its policy from, as stored. */
interface StoredConnection {
  readonly id: ConnectionId;
  readonly user: string | null;
  readonly resource: string | null;
  readonly policy: string | null;
  readonly revoked: boolean | null;
}

/**
 * The access a forwarded grant gives, or `refuse` when its user is no longer a member of the
 * organization or its toolkit's connection no longer belongs to them there. The grant serves the
 * URL's connection, `address` when it is not the stored connection's own id.
 */
const grantedAccess = <E>(
  input: {
    readonly user: string;
    readonly organization: string;
    readonly role: string | null;
    readonly mode: ApprovalMode;
    readonly connection: StoredConnection | undefined;
    readonly address?: ConnectionId | undefined;
  },
  refuse: E,
) =>
  Effect.gen(function* () {
    const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(input.organization).pipe(
      Effect.mapError(() => refuse),
    );
    const role = yield* Schema.decodeUnknownEffect(OrganizationRole)(input.role).pipe(
      Effect.mapError(() => refuse),
    );
    const stored = input.connection;
    let policy: GrantPolicy = { kind: "all" };
    if (stored !== undefined) {
      if (
        stored.revoked !== false ||
        stored.user !== input.user ||
        stored.resource !== organization
      )
        return yield* Effect.fail(refuse);
      policy = connectionGrantPolicy(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionPolicy))(stored.policy),
      );
    }
    const connection = stored?.id;
    const address = input.address ?? connection;
    return McpAccess.make({
      userId: input.user,
      clientId: v1ForwardClient,
      policy: grantAuthorization(policy),
      grant: {
        id: grantId({ user: input.user, organization, mode: input.mode, connection }),
        policy,
        target:
          address === undefined
            ? { kind: "mcp", mode: input.mode }
            : { kind: "mcp", mode: input.mode, connection: address },
      },
      access: { organization, owner: organizationOwner(organization), role },
    });
  });

/** Storage and decoding failures are an outage to retry, never a refusal. */
const outage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: () => Effect.fail(new AuthenticationUnavailable()),
      SchemaError: () => Effect.fail(new AuthenticationUnavailable()),
    }),
  );

/**
 * MCP access for a request v1 forwarded, checked against `secret`. A bearer that is not v1's, or
 * has expired, is unauthorized. A valid one whose account, organization or toolkit the import has
 * not mapped, or whose user is no longer a member there, is forbidden: v1 vouched for the caller,
 * and signing in again would not help.
 */
export const v1ForwardAccess = (
  secret: Option.Option<Redacted.Redacted<string>>,
  request: {
    readonly headers: Headers;
    readonly mode?: ApprovalMode | undefined;
    readonly organization?: OrganizationReference | undefined;
  },
) =>
  Effect.gen(function* () {
    const token = bearer(request.headers);
    // A deployment without the secret accepts no forwarded request.
    if (token === undefined || Option.isNone(secret)) return yield* unauthorized;
    const claims = yield* verify(secret.value, token);
    const row = yield* load(yield* SqlClient.SqlClient, claims);
    const forbidden = new McpForbidden({ reason: "membership" });
    if (row.userId === null || row.organization === null) return yield* forbidden;
    // v1 sends its requests to the bare URL; one that names an organization must name this one.
    if (
      request.organization !== undefined &&
      request.organization !== row.organization &&
      request.organization !== row.slug
    )
      return yield* new McpForbidden({ reason: "organization_mismatch" });
    // A toolkit runs under the caller's copy, the scoped connection its import made for them. v1
    // names it by the id the import gives a copy; one the opt-in import made keeps its earlier id.
    const copy = row.toolkitConnection;
    if (claims.toolkit !== undefined) {
      if (copy === null) return yield* forbidden;
      const derived = yield* toolkitCopyConnectionId(
        row.organization,
        claims.toolkit,
        claims.account,
      );
      if (claims.connection !== copy && claims.connection !== derived) return yield* forbidden;
    }
    return yield* grantedAccess(
      {
        user: row.userId,
        organization: row.organization,
        role: row.role,
        mode: request.mode ?? "model",
        connection:
          claims.toolkit === undefined || copy === null
            ? undefined
            : {
                id: ConnectionId.make(copy),
                user: row.connectionUser,
                resource: row.connectionResource,
                policy: row.connectionPolicy,
                revoked: row.connectionRevoked,
              },
        address: claims.connection,
      },
      forbidden,
    );
  }).pipe(outage, Effect.withSpan("auth.v1Forward"));

const GrantKey = Schema.fromJsonString(
  Schema.Tuple([
    Schema.NonEmptyString,
    Schema.NonEmptyString,
    ApprovalMode,
    Schema.NullOr(ConnectionId),
  ]),
);

/** Whether an MCP grant ID names a forwarded grant rather than an OAuth grant or a PAT. */
export const isV1ForwardGrant = (id: string) => id.startsWith(grantPrefix);

const BrowserRow = Schema.Struct({
  role: Schema.NullOr(Schema.String),
  connectionUser: Schema.NullOr(Schema.String),
  connectionResource: Schema.NullOr(Schema.String),
  connectionPolicy: Schema.NullOr(Schema.String),
  connectionRevoked: Schema.NullOr(Schema.Boolean),
});

/**
 * A forwarded grant for its browser approval page, opened by `sessionUser` (none when signed
 * out). Only the grant's own user may review its requests, while still a member.
 */
export const v1ForwardBrowserAccess = (id: string, sessionUser: string | undefined) =>
  Effect.gen(function* () {
    const key = Schema.decodeUnknownOption(GrantKey)(
      (() => {
        try {
          return decodeURIComponent(id.slice(grantPrefix.length));
        } catch {
          return "";
        }
      })(),
    );
    if (Option.isNone(key) || sessionUser === undefined) return yield* unauthorized;
    const [user, organization, mode, connection] = key.value;
    const refuse = new McpApprovalForbidden();
    if (sessionUser !== user) return yield* refuse;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      select
        (select role from member where "userId" = ${user} and "organizationId" = ${organization})
          as role,
        mc."userId" as "connectionUser",
        mc.resource as "connectionResource",
        mc.policy as "connectionPolicy",
        mc.revoked as "connectionRevoked"
      from (select 1) one
      left join "mcpConnection" mc on mc.id = ${connection}`;
    const row = yield* Schema.decodeUnknownEffect(BrowserRow)(rows[0]);
    return yield* grantedAccess(
      {
        user,
        organization,
        role: row.role,
        mode,
        connection:
          connection === null
            ? undefined
            : {
                id: connection,
                user: row.connectionUser,
                resource: row.connectionResource,
                policy: row.connectionPolicy,
                revoked: row.connectionRevoked,
              },
      },
      refuse,
    );
  }).pipe(outage, Effect.withSpan("auth.v1ForwardBrowser"));
