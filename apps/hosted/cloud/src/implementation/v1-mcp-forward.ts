import {
  AuthenticationUnavailable,
  McpAccess,
  McpApprovalForbidden,
  McpForbidden,
  McpUnauthorized,
  OrganizationId,
  OrganizationRole,
  organizationOwner,
  recordAuthFailure,
  recordCredential,
  type AuthFailureReason,
  type OrganizationReference,
} from "@executor-js/hosted-server";
import { ApprovalMode, GrantId, type GrantPolicy } from "@executor-js/mcp-auth";
import {
  ConnectionId,
  ConnectionPolicy,
  connectionGrantPolicy,
} from "@executor-js/mcp-auth/connections";
import { Clock, Effect, Option, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { SqlClient } from "effect/sql";

const prefix = "v1fwd.";

const toolkitCopyId = (toolkitRow: string, member: string) => `${toolkitRow}:${member}`;

const toolkitCopyConnectionId = (organization: string, toolkitRow: string, member: string) =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([organization, toolkitRow, member])),
    ),
  ).pipe(
    Effect.map(
      (digest) =>
        `v1-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 40)}`,
    ),
  );

export const v1ForwardClient = "executor-v1";

const lifetimeSeconds = 900;

const Claims = Schema.Struct({
  v: Schema.Literal(1),
  account: Schema.NonEmptyString,
  organization: Schema.NonEmptyString,
  exp: Schema.Int,
  toolkit: Schema.optionalKey(Schema.NonEmptyString),
  connection: Schema.optionalKey(ConnectionId),
});
type Claims = typeof Claims.Type;

const bearer = (headers: Headers) => headers.get("authorization")?.match(/^Bearer (\S+)$/iu)?.[1];

export const isV1Forward = (headers: Headers) => bearer(headers)?.startsWith(prefix) === true;

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
const rejected = (reason: AuthFailureReason) =>
  Effect.andThen(recordAuthFailure(reason), Effect.fail(unauthorized));

const verify = (secret: Redacted.Redacted<string>, token: string) =>
  Effect.gen(function* () {
    const [, payload, signature, ...rest] = token.split(".");
    if (payload === undefined || signature === undefined || rest.length > 0)
      return yield* rejected("malformed");
    const mac = Base64Url.decode(signature);
    if (Result.isFailure(mac)) return yield* rejected("malformed");
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
    if (!valid) return yield* rejected("unknown");
    const claims = yield* Base64Url.decodeString(payload).pipe(
      Result.match({
        onFailure: () => rejected("malformed"),
        onSuccess: (json) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(Claims))(json).pipe(
            Effect.catch(() => rejected("malformed")),
          ),
      }),
    );
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    if (claims.exp < now) return yield* rejected("expired");
    if (claims.exp > now + lifetimeSeconds) return yield* rejected("malformed");
    if ((claims.toolkit === undefined) !== (claims.connection === undefined))
      return yield* rejected("malformed");
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

interface StoredConnection {
  readonly id: ConnectionId;
  readonly user: string | null;
  readonly resource: string | null;
  readonly policy: string | null;
  readonly revoked: boolean | null;
}

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

const outage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: () => Effect.fail(new AuthenticationUnavailable()),
      SchemaError: () => Effect.fail(new AuthenticationUnavailable()),
    }),
  );

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
    yield* recordCredential({ kind: "v1_forward" });
    if (token === undefined) return yield* rejected("malformed");
    if (Option.isNone(secret)) return yield* rejected("unknown");
    const claims = yield* verify(secret.value, token);
    const row = yield* load(yield* SqlClient.SqlClient, claims);
    const forbidden = new McpForbidden({ reason: "membership" });
    if (row.userId !== null) yield* recordCredential({ kind: "v1_forward", user: row.userId });
    if (row.userId === null || row.organization === null)
      return yield* Effect.andThen(recordAuthFailure("not_member"), Effect.fail(forbidden));
    if (
      request.organization !== undefined &&
      request.organization !== row.organization &&
      request.organization !== row.slug
    )
      return yield* Effect.andThen(
        recordAuthFailure("organization_mismatch"),
        Effect.fail(new McpForbidden({ reason: "organization_mismatch" })),
      );
    const copy = row.toolkitConnection;
    if (claims.toolkit !== undefined) {
      if (copy === null)
        return yield* Effect.andThen(recordAuthFailure("wrong_resource"), Effect.fail(forbidden));
      const derived = yield* toolkitCopyConnectionId(
        row.organization,
        claims.toolkit,
        claims.account,
      );
      if (claims.connection !== copy && claims.connection !== derived)
        return yield* Effect.andThen(recordAuthFailure("wrong_resource"), Effect.fail(forbidden));
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
    ).pipe(Effect.tapError(() => recordAuthFailure("not_member")));
  }).pipe(outage, Effect.withSpan("auth.v1Forward"));

const GrantKey = Schema.fromJsonString(
  Schema.Tuple([
    Schema.NonEmptyString,
    Schema.NonEmptyString,
    ApprovalMode,
    Schema.NullOr(ConnectionId),
  ]),
);

export const isV1ForwardGrant = (id: string) => id.startsWith(grantPrefix);

const BrowserRow = Schema.Struct({
  role: Schema.NullOr(Schema.String),
  connectionUser: Schema.NullOr(Schema.String),
  connectionResource: Schema.NullOr(Schema.String),
  connectionPolicy: Schema.NullOr(Schema.String),
  connectionRevoked: Schema.NullOr(Schema.Boolean),
});

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
