import { defaultKeyHasher } from "@better-auth/api-key";
import {
  fullAuthority,
  selectedAuthority,
  type AuthorizationPolicy,
} from "@executor-js/authorization";
import {
  ApprovalMode,
  ConnectionId,
  GrantId,
  GrantPolicy,
  grantAuthorization,
  grantScope,
  grantTarget,
  recordedTarget,
  McpWhoami,
  type GrantTarget,
} from "@executor-js/mcp-auth";
import { ConnectionPolicy, connectionGrantPolicy } from "@executor-js/mcp-auth/connections";
import { Clock, Context, Effect, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { ApiKeyId, ApiKeyMetadata } from "../contracts/api-keys.ts";
import {
  OrganizationId,
  OrganizationReference,
  OrganizationRole,
  organizationOwner,
  type OrganizationAccess,
} from "../contracts/organization.ts";
import { McpAccess, McpForbidden, McpForbiddenReason, McpUnauthorized } from "../contracts/mcp.ts";
import { AuthFailureReason, AuthenticationUnavailable, Unauthorized } from "../contracts/auth.ts";
import { recordAuthFailure, recordCaller, recordCredential } from "./auth-telemetry.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { isApiKey } from "./api-keys.ts";
import { patGrantId, type HostedOAuthOrigins } from "./mcp-oauth.ts";

class BearerRejected extends Schema.TaggedError<BearerRejected>()("BearerRejected", {
  reason: Schema.Union([Schema.Literals(["unauthorized", "unavailable"]), McpForbiddenReason]),
  failure: Schema.optionalKey(AuthFailureReason),
}) {}

const unauthorized = (failure: AuthFailureReason) =>
  new BearerRejected({ reason: "unauthorized", failure });
const unavailable = new BearerRejected({ reason: "unavailable" });
const forbidden = (reason: McpForbiddenReason, failure: AuthFailureReason) =>
  new BearerRejected({ reason, failure });

export interface BearerRequest {
  readonly headers: Headers;
  readonly organization?: OrganizationReference | undefined;
  readonly desktop?: boolean | undefined;
  readonly tools?: boolean | undefined;
}

export interface ApiBearerAccess {
  readonly userId: string;
  readonly access: OrganizationAccess;
  readonly organizationSlug: string;
  readonly policy: AuthorizationPolicy;
  readonly key?: { readonly id: typeof ApiKeyId.Type };
  readonly grant?: { readonly id: GrantId };
  readonly desktop?: true;
}

const desktopAuthority = selectedAuthority(["discover"], { kind: "all" });

const bearer = (headers: Headers) => headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];

const noBearer = (headers: Headers) =>
  headers.has("authorization")
    ? Effect.fail(unauthorized("malformed"))
    : Effect.andThen(recordCredential({ kind: "none" }), Effect.fail(unauthorized("missing")));

const recordRefusal = (error: BearerRejected) =>
  error.failure === undefined ? Effect.void : recordAuthFailure(error.failure);

const storedHash = (token: string) =>
  Effect.gen(function* () {
    const hashes = yield* BearerHashes;
    const known = hashes?.get(token);
    if (known !== undefined) return known;
    const hash = yield* Effect.tryPromise({
      try: () => defaultKeyHasher(token),
      catch: () => unavailable,
    });
    hashes?.set(token, hash);
    return hash;
  });

export const BearerHashes = Context.Reference<Map<string, string> | undefined>(
  "hosted/BearerHashes",
  { defaultValue: () => undefined },
);

const jsonText = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return undefined;
  }
};
const Strings = Schema.Array(Schema.String);
const strings = (text: string | null) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Strings)(jsonText(text)));

const requestedOrganization = (
  request: BearerRequest,
  header: string | null,
  fromUrl: string,
  fromHeader: string,
) =>
  Effect.gen(function* () {
    if (header !== null && !Schema.is(OrganizationReference)(header))
      return yield* forbidden("membership", "malformed");
    const resolve = (matches: string) =>
      Schema.decodeUnknownEffect(Schema.Array(OrganizationId))(jsonText(matches)).pipe(
        Effect.mapError(() => unavailable),
        Effect.flatMap((ids) =>
          ids.length === 1 && ids[0] !== undefined
            ? Effect.succeed(ids[0])
            : Effect.fail(forbidden("membership", "organization_not_found")),
        ),
      );
    const byUrl = request.organization === undefined ? undefined : yield* resolve(fromUrl);
    const byHeader = header === null ? undefined : yield* resolve(fromHeader);
    if (byUrl !== undefined && byHeader !== undefined && byUrl !== byHeader)
      return yield* forbidden("organization_mismatch", "organization_mismatch");
    return byUrl ?? byHeader;
  });

const matches = (sql: SqlClient.SqlClient, reference: string | null) =>
  sql`(select coalesce(json_agg(o.id), '[]'::json)::text from (
    select id from organization where id = ${reference} or slug = ${reference} limit 2) o)`;

const ResourceRows = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ identifier: Schema.String, claims: Schema.Unknown })),
);

const OAuthRow = Schema.Struct({
  expiresAt: Schema.NullOr(Schema.Number),
  revoked: Schema.Boolean,
  clientActive: Schema.Boolean,
  session: Schema.NullOr(Schema.String),
  sessionExpiresAt: Schema.NullOr(Schema.Number),
  bound: Schema.Boolean,
  subject: Schema.NullOr(Schema.String),
  tokenClient: Schema.NullOr(Schema.String),
  grantReference: Schema.NullOr(Schema.String),
  scopes: Schema.NullOr(Schema.String),
  resources: Schema.NullOr(Schema.String),
  resourceRows: Schema.String,
  grantId: Schema.NullOr(Schema.String),
  grantUser: Schema.NullOr(Schema.String),
  grantClient: Schema.NullOr(Schema.String),
  grantResource: Schema.NullOr(Schema.String),
  grantPolicy: Schema.NullOr(Schema.String),
  grantRevoked: Schema.NullOr(Schema.Boolean),
  grantConnection: Schema.NullOr(Schema.String),
  grantMode: Schema.NullOr(Schema.String),
  consentResources: Schema.NullOr(Schema.String),
  role: Schema.NullOr(Schema.String),
  organizationSlug: Schema.NullOr(Schema.String),
  connectionId: Schema.NullOr(Schema.String),
  connectionUser: Schema.NullOr(Schema.String),
  connectionResource: Schema.NullOr(Schema.String),
  connectionPolicy: Schema.NullOr(Schema.String),
  connectionRevoked: Schema.NullOr(Schema.Boolean),
  urlOrganizations: Schema.String,
  headerOrganizations: Schema.String,
});

const loadOAuth = (
  sql: SqlClient.SqlClient,
  hash: string,
  url: string | null,
  header: string | null,
) =>
  sql`
  select
    floor(extract(epoch from t."expiresAt") * 1000)::float8 as "expiresAt",
    t.revoked is not null as revoked,
    t."clientId" is not null and c."clientId" is not null
      and c."clientDiscoveryId" is null and c.disabled is not true as "clientActive",
    t."sessionId" as session,
    floor(extract(epoch from s."expiresAt") * 1000)::float8 as "sessionExpiresAt",
    t.confirmation is not null as bound,
    u.id as subject,
    t."clientId" as "tokenClient",
    t."referenceId" as "grantReference",
    t.scopes::text as scopes,
    t.resources::text as resources,
    (select coalesce(json_agg(json_build_object(
        'identifier', r.identifier, 'claims', r."customClaims")), '[]'::json)::text
      from (
        select identifier, "customClaims" from "oauthResource"
        where identifier in (select jsonb_array_elements_text(
          case when jsonb_typeof(t.resources::jsonb) = 'array' then t.resources::jsonb
          else '[]'::jsonb end))
        union all
        select identifier, "customClaims" from "oauthResource"
        where jsonb_typeof(t.resources::jsonb) = 'string'
          and strpos(t.resources::jsonb #>> '{}', to_json(identifier)::text) > 0
      ) r) as "resourceRows",
    g.id as "grantId",
    g."userId" as "grantUser",
    g."clientId" as "grantClient",
    g.resource as "grantResource",
    g.policy as "grantPolicy",
    g.revoked as "grantRevoked",
    g.connection as "grantConnection",
    g.mode as "grantMode",
    consent.resources::text as "consentResources",
    m.role as role,
    o.slug as "organizationSlug",
    mc.id as "connectionId",
    mc."userId" as "connectionUser",
    mc.resource as "connectionResource",
    mc.policy as "connectionPolicy",
    mc.revoked as "connectionRevoked",
    ${matches(sql, url)} as "urlOrganizations",
    ${matches(sql, header)} as "headerOrganizations"
  from "oauthAccessToken" t
  left join "oauthClient" c on c."clientId" = t."clientId"
  left join session s on s.id = t."sessionId"
  left join "user" u on u.id = t."userId"
  left join "mcpGrant" g on g.id = t."referenceId"
  left join lateral (
    select resources from "oauthConsent"
    where "userId" = g."userId" and "clientId" = g."clientId" and "referenceId" = g.id
    limit 1) consent on true
  left join member m on m."userId" = g."userId" and m."organizationId" = g.resource
  left join organization o on o.id = g.resource
  left join "mcpConnection" mc on mc.id = g.connection
  where t.token = ${hash}`.pipe(Effect.mapError(() => unavailable));

const oauthAccess = (
  sql: SqlClient.SqlClient,
  { origin, resourceOrigins }: HostedOAuthOrigins,
  accepted: readonly GrantTarget["kind"][],
  token: string,
  request: BearerRequest,
) =>
  Effect.gen(function* () {
    const header = request.headers.get("x-executor-organization");
    yield* recordCredential({ kind: "oauth_access_token" });
    const rows = yield* loadOAuth(
      sql,
      yield* storedHash(token),
      request.organization ?? null,
      header,
    );
    if (rows[0] === undefined) return yield* unauthorized("unknown");
    const row = yield* Schema.decodeUnknownEffect(OAuthRow)(rows[0]).pipe(
      Effect.mapError(() => unavailable),
    );
    const now = yield* Clock.currentTimeMillis;
    if (row.revoked) return yield* unauthorized("revoked");
    if (row.expiresAt === null || row.expiresAt < now) return yield* unauthorized("expired");
    if (!row.clientActive) return yield* unauthorized("revoked");
    if (row.bound) return yield* unauthorized("wrong_resource");
    if (row.session !== null && (row.sessionExpiresAt === null || row.sessionExpiresAt < now))
      return yield* unauthorized("expired");
    if (row.subject === null || row.tokenClient === null) return yield* unauthorized("revoked");
    yield* recordCredential({ kind: "oauth_access_token", id: row.tokenClient, user: row.subject });
    const scopes = strings(row.scopes) ?? [];
    const resources = strings(row.resources) ?? [];
    const userInfo = `${origin}/api/auth/oauth2/userinfo`;
    const stored = new Map(
      (yield* Schema.decodeUnknownEffect(ResourceRows)(row.resourceRows).pipe(
        Effect.mapError(() => unavailable),
      )).map(({ identifier, claims }) => [identifier, claims]),
    );
    if (
      resources.length === 0 ||
      resources.some((resource) => resource !== userInfo && !stored.has(resource))
    )
      return yield* unauthorized("wrong_resource");
    const audiences =
      scopes.includes("openid") && !resources.includes(userInfo)
        ? [...resources, userInfo]
        : resources;
    const claimedGrant = resources
      .map((resource) => stored.get(resource))
      .filter(
        (claims): claims is object =>
          typeof claims === "object" && claims !== null && Object.hasOwn(claims, "grant_id"),
      )
      .at(-1);
    if (claimedGrant !== undefined && Reflect.get(claimedGrant, "grant_id") !== row.grantReference)
      return yield* unauthorized("wrong_resource");
    const grantId = yield* Schema.decodeUnknownEffect(GrantId)(row.grantReference).pipe(
      Effect.mapError(() => unauthorized("wrong_resource")),
    );
    if (row.grantId === null || row.grantRevoked !== false) return yield* unauthorized("revoked");
    if (
      row.grantUser !== row.subject ||
      row.grantClient !== row.tokenClient ||
      row.grantResource === null ||
      row.grantResource.length === 0
    )
      return yield* unauthorized("wrong_resource");
    const consented = row.consentResources === null ? [] : (strings(row.consentResources) ?? []);
    const audience: GrantTarget | undefined = grantTarget(resourceOrigins, consented);
    if (audience === undefined) return yield* unauthorized("wrong_resource");
    if (
      audiences.length !== 1 ||
      audiences[0] !== consented[0] ||
      !accepted.includes(audience.kind)
    )
      return yield* unauthorized("wrong_resource");
    const record = {
      mode: yield* Schema.decodeUnknownEffect(Schema.NullOr(ApprovalMode))(row.grantMode).pipe(
        Effect.mapError(() => unauthorized("unknown")),
      ),
      connection: yield* Schema.decodeUnknownEffect(Schema.NullOr(ConnectionId))(
        row.grantConnection,
      ).pipe(Effect.mapError(() => unauthorized("unknown"))),
    };
    const target = recordedTarget(record, audience);
    if (target === undefined) return yield* unauthorized("wrong_resource");
    if (!scopes.includes(grantScope(audience.kind)))
      return yield* unauthorized("insufficient_scope");
    const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(row.grantResource).pipe(
      Effect.mapError(() => forbidden("membership", "not_member")),
    );
    const role = yield* Schema.decodeUnknownEffect(OrganizationRole)(row.role).pipe(
      Effect.mapError(() => forbidden("membership", "not_member")),
    );
    yield* recordCaller(organization, row.subject);
    const connection = record.connection ?? undefined;
    const policy =
      connection === undefined
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GrantPolicy))(
            row.grantPolicy,
          ).pipe(Effect.mapError(() => unauthorized("unknown")))
        : row.connectionId === null || row.connectionRevoked !== false
          ? yield* unauthorized("revoked")
          : row.connectionUser !== row.grantUser || row.connectionResource !== row.grantResource
            ? yield* unauthorized("wrong_resource")
            : connectionGrantPolicy(
                yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionPolicy))(
                  row.connectionPolicy,
                ).pipe(Effect.mapError(() => unavailable)),
              );
    const requested = yield* requestedOrganization(
      request,
      header,
      row.urlOrganizations,
      row.headerOrganizations,
    );
    if (requested !== undefined && requested !== organization)
      return yield* forbidden("organization_mismatch", "organization_mismatch");
    return {
      kind: audience.kind,
      userId: row.subject,
      clientId: row.tokenClient,
      grant: { id: grantId, policy, target },
      access: { organization, owner: organizationOwner(organization), role },
      organizationSlug: row.organizationSlug,
    };
  });

const PatRow = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  metadata: Schema.NullOr(Schema.String),
  expiresAt: Schema.NullOr(Schema.Number),
  usable: Schema.Boolean,
  contended: Schema.Boolean,
  userExists: Schema.Boolean,
  memberships: Schema.String,
  urlOrganizations: Schema.String,
  headerOrganizations: Schema.String,
});
const Memberships = Schema.Array(
  Schema.Struct({
    organization: Schema.String,
    role: Schema.String,
    slug: Schema.NullOr(Schema.String),
  }),
);

const lastRequestPrecision = 60_000;

const loadPat = (
  sql: SqlClient.SqlClient,
  hash: string,
  at: number,
  url: string | null,
  header: string | null,
) =>
  sql`
  with k as (
    select id, "referenceId", metadata, "expiresAt",
      enabled is not false and remaining is null as usable,
      enabled is not false and "expiresAt" < to_timestamp(${at}::float8 / 1000) as expired,
      "lastRequest" > to_timestamp(${at - lastRequestPrecision}::float8 / 1000) as recorded
    from apikey where key = ${hash}
  ), used as (
    update apikey set "lastRequest" = to_timestamp(${at}::float8 / 1000),
      "updatedAt" = to_timestamp(${at}::float8 / 1000)
    where id in (select id from k
      where usable and not coalesce(expired, false) and not coalesce(recorded, false))
      and enabled is not false and remaining is null
      and ("expiresAt" is null or "expiresAt" >= to_timestamp(${at}::float8 / 1000))
      and ("lastRequest" is null
        or "lastRequest" <= to_timestamp(${at - lastRequestPrecision}::float8 / 1000))
    returning id
  ), deleted as (
    delete from apikey where id in (select id from k where expired) returning id
  )
  select
    k.id,
    k."referenceId" as "userId",
    k.metadata,
    floor(extract(epoch from k."expiresAt") * 1000)::float8 as "expiresAt",
    k.usable and not coalesce(k.expired, false)
      and (coalesce(k.recorded, false) or exists (select 1 from used)) as usable,
    k.usable and not coalesce(k.expired, false) and not coalesce(k.recorded, false)
      and not exists (select 1 from used) as contended,
    exists (select 1 from "user" u where u.id = k."referenceId") as "userExists",
    (select coalesce(json_agg(json_build_object(
        'organization', m."organizationId", 'role', m.role, 'slug', o.slug)), '[]'::json)::text
      from member m left join organization o on o.id = m."organizationId"
      where m."userId" = k."referenceId") as memberships,
    ${matches(sql, url)} as "urlOrganizations",
    ${matches(sql, header)} as "headerOrganizations"
  from k`.pipe(Effect.mapError(() => unavailable));

const KeyMetadata = Schema.NullOr(ApiKeyMetadata);

const holdsRole = (memberships: string, organization: string) =>
  Option.match(Schema.decodeUnknownOption(Memberships)(jsonText(memberships)), {
    onNone: () => false,
    onSome: (items) =>
      items.some(
        (item) => item.organization === organization && Schema.is(OrganizationRole)(item.role),
      ),
  });

export interface UnknownApiKeys {
  readonly store: (
    token: Redacted.Redacted<string>,
  ) => Effect.Effect<boolean, AuthenticationUnavailable, SqlClient.SqlClient>;
}

const patAccess = (
  sql: SqlClient.SqlClient,
  token: string,
  request: BearerRequest,
  unknownKeys: UnknownApiKeys | undefined,
) =>
  Effect.gen(function* () {
    const header = request.headers.get("x-executor-organization");
    yield* recordCredential({ kind: "api_key" });
    const hash = yield* storedHash(token);
    const read = Effect.gen(function* () {
      const rows = yield* loadPat(
        sql,
        hash,
        yield* Clock.currentTimeMillis,
        request.organization ?? null,
        header,
      );
      if (rows[0] === undefined) return Option.none();
      return Option.some(
        yield* Schema.decodeUnknownEffect(PatRow)(rows[0]).pipe(Effect.mapError(() => unavailable)),
      );
    });
    const load = Effect.flatMap(read, (row) =>
      Option.isSome(row) ? Effect.succeed(row.value) : Effect.fail(unauthorized("unknown")),
    );
    const found = yield* read;
    const stored =
      Option.isNone(found) &&
      unknownKeys !== undefined &&
      (yield* unknownKeys.store(Redacted.make(token)).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(() => unavailable),
      ));
    const first = Option.isSome(found) ? found.value : stored ? yield* load : undefined;
    if (first === undefined) return yield* unauthorized("unknown");
    const row = first.contended ? yield* load : first;
    if (row.contended) return yield* unavailable;
    const now = yield* Clock.currentTimeMillis;
    yield* recordCredential({ kind: "api_key", id: row.id });
    if (row.expiresAt !== null && now > row.expiresAt) return yield* unauthorized("expired");
    if (!row.usable || !row.userExists) return yield* unauthorized("revoked");
    const id = yield* Schema.decodeUnknownEffect(ApiKeyId)(row.id).pipe(
      Effect.mapError(() => unavailable),
    );
    yield* recordCredential({ kind: "api_key", id, user: row.userId });
    const metadata = yield* Schema.decodeUnknownEffect(KeyMetadata)(jsonText(row.metadata)).pipe(
      Effect.mapError(() => unauthorized("unknown")),
    );
    const pinned = metadata?.organization;
    if (pinned !== undefined && holdsRole(row.memberships, pinned))
      yield* recordCaller(pinned, row.userId);
    const organization =
      (yield* requestedOrganization(
        request,
        header,
        row.urlOrganizations,
        row.headerOrganizations,
      )) ?? pinned;
    if (organization === undefined)
      return yield* forbidden("organization_required", "organization_required");
    if (pinned !== undefined && pinned !== organization)
      return yield* forbidden("organization_mismatch", "organization_mismatch");
    const memberships = yield* Schema.decodeUnknownEffect(Memberships)(
      jsonText(row.memberships),
    ).pipe(Effect.mapError(() => unavailable));
    const membership = memberships.find((item) => item.organization === organization);
    const role = yield* Schema.decodeUnknownEffect(OrganizationRole)(membership?.role).pipe(
      Effect.mapError(() => forbidden("membership", "not_member")),
    );
    if (pinned === undefined) yield* recordCaller(organization, row.userId);
    return {
      userId: row.userId,
      id,
      access: { organization, owner: organizationOwner(organization), role },
      organizationSlug: membership?.slug ?? null,
    };
  });

export const mcpBearerAccess = (
  origins: HostedOAuthOrigins,
  request: BearerRequest & { readonly mode?: ApprovalMode | undefined },
  unknownKeys?: UnknownApiKeys,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const token = bearer(request.headers);
    if (token === undefined) return yield* noBearer(request.headers);
    if (!isApiKey(token)) {
      const grant = yield* oauthAccess(sql, origins, ["mcp"], token, request);
      return McpAccess.make({
        userId: grant.userId,
        clientId: grant.clientId,
        grant: grant.grant,
        access: grant.access,
      });
    }
    const key = yield* patAccess(sql, token, request, unknownKeys);
    const mode = request.mode ?? "automatic";
    return McpAccess.make({
      userId: key.userId,
      clientId: `pat:${key.id}`,
      grant: {
        id: patGrantId({ token: key.id, organization: key.access.organization, mode }),
        policy: { kind: "all" },
        target: { kind: "mcp", mode },
      },
      access: key.access,
    });
  }).pipe(
    Effect.tapError(recordRefusal),
    Effect.mapError(({ reason }) =>
      reason === "unauthorized"
        ? new McpUnauthorized()
        : reason === "unavailable"
          ? new AuthenticationUnavailable()
          : new McpForbidden({ reason }),
    ),
  );

const WhoamiRow = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  connectionName: Schema.NullOr(Schema.String),
});

export const describeMcpAccess = (access: McpAccess) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const target = access.grant.target;
    if (target.kind !== "mcp") return yield* new McpUnauthorized();
    const connection = target.connection ?? null;
    const rows = yield* sql`
      select o.slug, o.name,
        (select mc.name from "mcpConnection" mc
          where mc.id = ${connection} and mc.revoked is false) as "connectionName"
      from organization o where o.id = ${access.access.organization}`.pipe(
      Effect.mapError(() => new AuthenticationUnavailable()),
    );
    const row = yield* Schema.decodeUnknownEffect(WhoamiRow)(rows[0]).pipe(
      Effect.mapError(() => new AuthenticationUnavailable()),
    );
    const policy = access.grant.policy;
    const apps = policy.kind === "tools" ? policy.apps.length : 0;
    if (target.connection !== undefined && row.connectionName === null)
      return yield* new McpUnauthorized();
    return McpWhoami.make({
      organization: { id: access.access.organization, slug: row.slug, name: row.name },
      access:
        target.connection !== undefined && row.connectionName !== null
          ? { kind: "connection", id: target.connection, name: row.connectionName, apps }
          : policy.kind === "tools"
            ? { kind: "tools", apps }
            : { kind: "all" },
      mode: target.mode,
    });
  });

export const apiBearerAccess = (
  origins: HostedOAuthOrigins,
  request: BearerRequest,
  unknownKeys?: UnknownApiKeys,
) => {
  const token = bearer(request.headers);
  const presentedKey = token !== undefined && isApiKey(token);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (token === undefined) return yield* noBearer(request.headers);
    const access: Omit<ApiBearerAccess, "organizationSlug"> & {
      readonly organizationSlug: string | null;
    } = isApiKey(token)
      ? yield* patAccess(sql, token, request, unknownKeys).pipe(
          Effect.map((key) => ({
            userId: key.userId,
            key: { id: key.id },
            policy: fullAuthority,
            access: key.access,
            organizationSlug: key.organizationSlug,
          })),
        )
      : yield* oauthAccess(
          sql,
          origins,
          [
            "api",
            ...(request.desktop === true ? (["desktop"] as const) : []),
            ...(request.tools === true ? (["mcp"] as const) : []),
          ],
          token,
          request,
        ).pipe(
          Effect.map((grant) => ({
            userId: grant.userId,
            grant: { id: grant.grant.id },
            access: grant.access,
            ...(grant.kind === "desktop"
              ? { policy: desktopAuthority, desktop: true as const }
              : { policy: grantAuthorization(grant.grant.policy) }),
            organizationSlug: grant.organizationSlug,
          })),
        );
    const organizationSlug = access.organizationSlug;
    if (organizationSlug === null || organizationSlug.length === 0)
      return yield* forbidden("membership", "not_member");
    return { ...access, organizationSlug } satisfies ApiBearerAccess;
  }).pipe(
    Effect.tapError(recordRefusal),
    Effect.mapError(({ reason, failure }) =>
      reason === "unauthorized"
        ? new Unauthorized(
            presentedKey &&
              (failure === "unknown" || failure === "revoked" || failure === "expired")
              ? { credential: "apiKey" }
              : {},
          )
        : reason === "unavailable"
          ? new AuthenticationUnavailable()
          : new OrganizationForbidden(),
    ),
  );
};
