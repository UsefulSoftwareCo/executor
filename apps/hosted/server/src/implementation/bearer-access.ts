/**
 * MCP and API bearer authentication in one SQL statement.
 *
 * Every MCP request, and every tool call inside `execute`, authenticates its bearer again.
 * Cloud reaches its database across the network, so each statement costs a round trip of
 * 3–6 ms. Better Auth's token check, the grant, consent, connection, membership and
 * organization reads used to run one after another: ten round trips for an OAuth token and
 * five, two of them writes, for a PAT. This module reads every row one authentication
 * needs in one statement and applies the same checks to the result.
 *
 * The checks mirror `@better-auth/oauth-provider`'s opaque access token validation and
 * `@better-auth/api-key`'s verification (both 1.7.5, as configured in `auth.ts` and
 * `api-keys.ts`), followed by the grant rules in `@executor-js/mcp-auth`. Expiry is decided
 * with the application clock after the statement returns, as Better Auth decides it, never
 * with the database clock.
 */
import { defaultKeyHasher } from "@better-auth/api-key";
import { fullAuthority, type AuthorizationPolicy } from "@executor-js/authorization";
import {
  GrantId,
  GrantPolicy,
  grantAuthorization,
  grantTarget,
  type ApprovalMode,
  type GrantTarget,
} from "@executor-js/mcp-auth";
import { ConnectionPolicy, connectionGrantPolicy } from "@executor-js/mcp-auth/connections";
import { Clock, Effect, Option, Schema } from "effect";
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
import { AuthenticationUnavailable, Unauthorized } from "../contracts/auth.ts";
import { OrganizationForbidden } from "../contracts/organization.ts";
import { isApiKey } from "./api-keys.ts";
import { patGrantId, type HostedOAuthOrigins } from "./mcp-oauth.ts";

/**
 * Why a bearer was refused, before translation into the MCP or API contract. A valid credential
 * that may not make the request names why, because each reason needs a different fix.
 */
class BearerRejected extends Schema.TaggedError<BearerRejected>()("BearerRejected", {
  reason: Schema.Union([Schema.Literals(["unauthorized", "unavailable"]), McpForbiddenReason]),
}) {}

const unauthorized = new BearerRejected({ reason: "unauthorized" });
const unavailable = new BearerRejected({ reason: "unavailable" });
const forbidden = (reason: McpForbiddenReason) => new BearerRejected({ reason });

/** What the request names: the presented credential and any organization it selects. */
export interface BearerRequest {
  readonly headers: Headers;
  /** The organization in the URL (`/org/<ref>/mcp`) or the API's `organization` parameter. */
  readonly organization?: OrganizationReference | undefined;
}

export interface ApiBearerAccess {
  readonly userId: string;
  readonly access: OrganizationAccess;
  readonly organizationSlug: string;
  readonly policy: AuthorizationPolicy;
  readonly key?: { readonly id: typeof ApiKeyId.Type };
}

const bearer = (headers: Headers) => headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];

/**
 * Better Auth stores opaque access tokens and API keys as the unpadded base64url SHA-256 of
 * the credential (oauth-provider's default `storeTokens: "hashed"`, api-key's default hasher).
 */
const storedHash = (token: string) =>
  Effect.tryPromise({ try: () => defaultKeyHasher(token), catch: () => unavailable });

/**
 * A stored `string[]` (a `jsonb` column), as Better Auth reads it: the driver decodes the
 * `jsonb` value, and the Kysely adapter (`supportsArrays: false`) parses it again when that
 * value is a string. A JSON string holding an array therefore reads as the array; anything
 * deeper stays a string and fails the array schema. The api-key plugin reads `metadata` the
 * same way: its output transform parses the text, then a string result is parsed once more.
 */
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

/**
 * The organization a request names, URL first, then `X-Executor-Organization`. Each reference
 * must match exactly one organization by ID or slug, and the two must agree.
 */
const requestedOrganization = (
  request: BearerRequest,
  header: string | null,
  fromUrl: string,
  fromHeader: string,
) =>
  Effect.gen(function* () {
    if (header !== null && !Schema.is(OrganizationReference)(header))
      return yield* forbidden("membership");
    const resolve = (matches: string) =>
      Schema.decodeUnknownEffect(Schema.Array(OrganizationId))(jsonText(matches)).pipe(
        Effect.mapError(() => unavailable),
        Effect.flatMap((ids) =>
          ids.length === 1 && ids[0] !== undefined
            ? Effect.succeed(ids[0])
            : Effect.fail(forbidden("membership")),
        ),
      );
    const byUrl = request.organization === undefined ? undefined : yield* resolve(fromUrl);
    const byHeader = header === null ? undefined : yield* resolve(fromHeader);
    if (byUrl !== undefined && byHeader !== undefined && byUrl !== byHeader)
      return yield* forbidden("organization_mismatch");
    return byUrl ?? byHeader;
  });

/** Organizations matching a reference by ID or slug; two rows prove the reference ambiguous. */
const matches = (sql: SqlClient.SqlClient, reference: string | null) =>
  sql`(select coalesce(json_agg(o.id), '[]'::json)::text from (
    select id from organization where id = ${reference} or slug = ${reference} limit 2) o)`;

/** Stored resources that a token's audience names: the identifier and its `customClaims`. */
const ResourceRows = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ identifier: Schema.String, claims: Schema.Unknown })),
);

/**
 * Timestamps are selected as epoch milliseconds, truncated as the driver truncates them into a
 * `Date`, so the caller can compare them with its own clock.
 */
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

/**
 * An OAuth access token, its grant, consent and connection, and the grant's membership.
 * Resource rows are every stored resource the token's audience can name; a JSON-string
 * audience (see {@link jsonText}) matches by its quoted identifier, and the caller keeps only
 * the identifiers the decoded audience actually lists.
 */
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

/** An OAuth grant for `kind`, as `@executor-js/mcp-auth` and hosted membership authorize it. */
const oauthAccess = (
  sql: SqlClient.SqlClient,
  { origin, resourceOrigins }: HostedOAuthOrigins,
  kind: "mcp" | "api",
  token: string,
  request: BearerRequest,
) =>
  Effect.gen(function* () {
    const header = request.headers.get("x-executor-organization");
    const rows = yield* loadOAuth(
      sql,
      yield* storedHash(token),
      request.organization ?? null,
      header,
    );
    if (rows[0] === undefined) return yield* unauthorized;
    const row = yield* Schema.decodeUnknownEffect(OAuthRow)(rows[0]).pipe(
      Effect.mapError(() => unavailable),
    );
    // Better Auth's opaque token validation: live token, enabled client, live session. It reads
    // the clock after its reads, so a token that expires during the round trip is refused.
    const now = yield* Clock.currentTimeMillis;
    if (row.expiresAt === null || row.expiresAt < now || row.revoked) return yield* unauthorized;
    if (!row.clientActive || row.bound) return yield* unauthorized;
    if (row.session !== null && (row.sessionExpiresAt === null || row.sessionExpiresAt < now))
      return yield* unauthorized;
    if (row.subject === null || row.tokenClient === null) return yield* unauthorized;
    // Every audience must still name a stored resource; `openid` adds the userinfo audience.
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
      return yield* unauthorized;
    const audiences =
      scopes.includes("openid") && !resources.includes(userInfo)
        ? [...resources, userInfo]
        : resources;
    // Better Auth merges each audience resource's `customClaims` over the configured claims, in
    // audience order, and `grant_id` is not a reserved claim: a resource's `grant_id` selects
    // the grant. A token is only accepted for the grant it was issued for, so a resource that
    // names any other grant refuses it.
    const claimedGrant = resources
      .map((resource) => stored.get(resource))
      .filter(
        (claims): claims is object =>
          typeof claims === "object" && claims !== null && Object.hasOwn(claims, "grant_id"),
      )
      .at(-1);
    if (claimedGrant !== undefined && Reflect.get(claimedGrant, "grant_id") !== row.grantReference)
      return yield* unauthorized;
    // The grant this token was issued for, held by the same user and client.
    const grantId = yield* Schema.decodeUnknownEffect(GrantId)(row.grantReference).pipe(
      Effect.mapError(() => unauthorized),
    );
    if (row.grantId === null || row.grantRevoked !== false) return yield* unauthorized;
    if (
      row.grantUser !== row.subject ||
      row.grantClient !== row.tokenClient ||
      row.grantResource === null ||
      row.grantResource.length === 0
    )
      return yield* unauthorized;
    // The consent's one resource, at any of this deployment's origins, is the token's audience.
    const consented = row.consentResources === null ? [] : (strings(row.consentResources) ?? []);
    const target: GrantTarget | undefined = grantTarget(resourceOrigins, consented);
    if (target === undefined) return yield* unauthorized;
    if (
      audiences.length !== 1 ||
      audiences[0] !== consented[0] ||
      target.kind !== kind ||
      !scopes.includes(kind === "api" ? "executor" : "mcp")
    )
      return yield* unauthorized;
    // Live membership in the grant's organization.
    const organization = yield* Schema.decodeUnknownEffect(OrganizationId)(row.grantResource).pipe(
      Effect.mapError(() => forbidden("membership")),
    );
    const role = yield* Schema.decodeUnknownEffect(OrganizationRole)(row.role).pipe(
      Effect.mapError(() => forbidden("membership")),
    );
    // A connection grant has no authority of its own; it reads the connection on every use.
    const connection = row.grantConnection ?? undefined;
    if (connection !== (target.kind === "mcp" ? target.connection : undefined))
      return yield* unauthorized;
    const policy =
      connection === undefined
        ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GrantPolicy))(
            row.grantPolicy,
          ).pipe(Effect.mapError(() => unauthorized))
        : row.connectionId === null ||
            row.connectionRevoked !== false ||
            row.connectionUser !== row.grantUser ||
            row.connectionResource !== row.grantResource
          ? yield* unauthorized
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
      return yield* forbidden("organization_mismatch");
    return {
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

/**
 * A personal access token, its owner and the owner's memberships. The statement applies Better
 * Auth's writes with the application clock `at` (epoch milliseconds): a live key records its use (`lastRequest`,
 * `updatedAt`), and an enabled key past its expiry is deleted, so an expired credential's hash
 * does not outlive its first refused use. The caller still decides expiry with its clock after
 * the statement, as Better Auth does. Executor never sets per-key quotas, so a key with
 * `remaining` set is refused rather than used without consuming its quota.
 */
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
      enabled is not false and "expiresAt" < to_timestamp(${at}::float8 / 1000) as expired
    from apikey where key = ${hash}
  ), used as (
    update apikey set "lastRequest" = to_timestamp(${at}::float8 / 1000),
      "updatedAt" = to_timestamp(${at}::float8 / 1000)
    where id in (select id from k where usable and not coalesce(expired, false)) returning id
  ), deleted as (
    delete from apikey where id in (select id from k where expired) returning id
  )
  select
    k.id,
    k."referenceId" as "userId",
    k.metadata,
    floor(extract(epoch from k."expiresAt") * 1000)::float8 as "expiresAt",
    k.usable and exists (select 1 from used) as usable,
    exists (select 1 from "user" u where u.id = k."referenceId") as "userExists",
    (select coalesce(json_agg(json_build_object(
        'organization', m."organizationId", 'role', m.role, 'slug', o.slug)), '[]'::json)::text
      from member m left join organization o on o.id = m."organizationId"
      where m."userId" = k."referenceId") as memberships,
    ${matches(sql, url)} as "urlOrganizations",
    ${matches(sql, header)} as "headerOrganizations"
  from k`.pipe(Effect.mapError(() => unavailable));

const KeyMetadata = Schema.NullOr(ApiKeyMetadata);

const patAccess = (sql: SqlClient.SqlClient, token: string, request: BearerRequest) =>
  Effect.gen(function* () {
    const header = request.headers.get("x-executor-organization");
    const hash = yield* storedHash(token);
    const rows = yield* loadPat(
      sql,
      hash,
      yield* Clock.currentTimeMillis,
      request.organization ?? null,
      header,
    );
    if (rows[0] === undefined) return yield* unauthorized;
    const row = yield* Schema.decodeUnknownEffect(PatRow)(rows[0]).pipe(
      Effect.mapError(() => unavailable),
    );
    // Disabled, expired and deleted-user keys are refused.
    const now = yield* Clock.currentTimeMillis;
    if (!row.usable || (row.expiresAt !== null && now > row.expiresAt) || !row.userExists)
      return yield* unauthorized;
    const id = yield* Schema.decodeUnknownEffect(ApiKeyId)(row.id).pipe(
      Effect.mapError(() => unavailable),
    );
    // Unreadable metadata fails closed: it cannot prove the key is an unpinned PAT.
    const metadata = yield* Schema.decodeUnknownEffect(KeyMetadata)(jsonText(row.metadata)).pipe(
      Effect.mapError(() => unauthorized),
    );
    const pinned = metadata?.organization;
    // The named organization, else the one the key is pinned to.
    const organization =
      (yield* requestedOrganization(
        request,
        header,
        row.urlOrganizations,
        row.headerOrganizations,
      )) ?? pinned;
    if (organization === undefined) return yield* forbidden("organization_required");
    // A pinned key never authorizes another organization.
    if (pinned !== undefined && pinned !== organization)
      return yield* forbidden("organization_mismatch");
    const memberships = yield* Schema.decodeUnknownEffect(Memberships)(
      jsonText(row.memberships),
    ).pipe(Effect.mapError(() => unavailable));
    const membership = memberships.find((item) => item.organization === organization);
    const role = yield* Schema.decodeUnknownEffect(OrganizationRole)(membership?.role).pipe(
      Effect.mapError(() => forbidden("membership")),
    );
    return {
      userId: row.userId,
      id,
      access: { organization, owner: organizationOwner(organization), role },
      organizationSlug: membership?.slug ?? null,
    };
  });

/** MCP authority for an OAuth grant or a PAT, with live grant, connection and membership. */
export const mcpBearerAccess = (
  origins: HostedOAuthOrigins,
  request: BearerRequest & { readonly mode?: ApprovalMode | undefined },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const token = bearer(request.headers);
    if (token === undefined) return yield* unauthorized;
    if (!isApiKey(token)) {
      const grant = yield* oauthAccess(sql, origins, "mcp", token, request);
      return McpAccess.make({
        userId: grant.userId,
        clientId: grant.clientId,
        grant: grant.grant,
        access: grant.access,
      });
    }
    const key = yield* patAccess(sql, token, request);
    const mode = request.mode ?? "model";
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
    Effect.mapError(({ reason }) =>
      reason === "unauthorized"
        ? new McpUnauthorized()
        : reason === "unavailable"
          ? new AuthenticationUnavailable()
          : new McpForbidden({ reason }),
    ),
  );

/** Executor API authority for an OAuth grant or a PAT, with the organization's slug. */
export const apiBearerAccess = (origins: HostedOAuthOrigins, request: BearerRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const token = bearer(request.headers);
    if (token === undefined) return yield* unauthorized;
    const access: Omit<ApiBearerAccess, "organizationSlug"> & {
      readonly organizationSlug: string | null;
    } = isApiKey(token)
      ? yield* patAccess(sql, token, request).pipe(
          Effect.map((key) => ({
            userId: key.userId,
            key: { id: key.id },
            policy: fullAuthority,
            access: key.access,
            organizationSlug: key.organizationSlug,
          })),
        )
      : yield* oauthAccess(sql, origins, "api", token, request).pipe(
          Effect.map((grant) => ({
            userId: grant.userId,
            access: grant.access,
            policy: grantAuthorization(grant.grant.policy),
            organizationSlug: grant.organizationSlug,
          })),
        );
    const organizationSlug = access.organizationSlug;
    if (organizationSlug === null || organizationSlug.length === 0)
      return yield* forbidden("membership");
    return { ...access, organizationSlug } satisfies ApiBearerAccess;
  }).pipe(
    Effect.mapError(({ reason }) =>
      reason === "unauthorized"
        ? new Unauthorized()
        : reason === "unavailable"
          ? new AuthenticationUnavailable()
          : new OrganizationForbidden(),
    ),
  );
