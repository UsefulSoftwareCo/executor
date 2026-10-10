import { isToolSelectionSubset } from "@executor-js/authorization";
/** Better Auth owns OAuth and token rotation; this plugin owns explicit, revocable grants. */
import type { BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
import { defineRequestState } from "@better-auth/core/context";
import {
  oauthProvider,
  seedOAuthResources,
  getOAuthProviderApi,
  type OAuthOptions,
  type OAuthResourceSeedContext,
  type Scope,
} from "@better-auth/oauth-provider";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { Clock, Effect, Option, Schema } from "effect";
import { authCall, parse, runAuth } from "./auth-call.ts";
import { deviceAuthorizationPlugin } from "./device-authorization.ts";
import {
  ConnectionId,
  Grant,
  GrantId,
  GrantPolicy,
  GrantTarget,
  approvalRefusal,
  defaultResource,
  grantTarget,
  mcpOAuthResources,
  OAuthResourceProvisioningFailed,
  type ResourceOrigins,
} from "../contracts/grant.ts";
import {
  Connection,
  ConnectionName,
  ConnectionPolicy,
  connectionGrantPlaceholder,
  connectionGrantPolicy,
} from "../contracts/connection.ts";
import { ConnectedAgent, type ConnectedAgentAccess } from "../contracts/agents.ts";

export type { OAuthResourceSeedContext } from "@better-auth/oauth-provider";
export { authCall, runAuth } from "./auth-call.ts";

const Record = Schema.Struct({
  id: GrantId,
  userId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  policy: Schema.String,
  revoked: Schema.Boolean,
  connection: Schema.optionalKey(Schema.NullOr(ConnectionId)),
});
const ConnectionRecord = Schema.Struct({
  id: ConnectionId,
  userId: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  name: ConnectionName,
  policy: Schema.String,
  revoked: Schema.Boolean,
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});
/** Server-only connection calls name the verified user and host resource explicitly. */
const ConnectionOwner = { userId: Schema.NonEmptyString, resource: Schema.NonEmptyString };
/** Verified credential identity plus the current persisted grant, independent of host ownership. */
export const GrantAccess = Schema.Struct({
  userId: Schema.String,
  clientId: Schema.String,
  resource: Schema.String,
  grant: Grant,
});
export type GrantAccess = typeof GrantAccess.Type;
const Claims = Schema.Struct({
  sub: Schema.String,
  client_id: Schema.String,
  grant_id: GrantId,
  scope: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  cnf: Schema.optionalKey(Schema.Unknown),
});
const Registration = Schema.Struct({
  application_type: Schema.optionalKey(Schema.String),
  redirect_uris: Schema.Array(Schema.String),
});
/** Authorization parameters this plugin reads; every other parameter passes through unchanged. */
const AuthorizeRequest = Schema.StructWithRest(
  Schema.Struct({
    scope: Schema.optionalKey(Schema.String),
    resource: Schema.optionalKey(Schema.Unknown),
    request_uri: Schema.optionalKey(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const selected = defineRequestState<{ userId: string; id: GrantId } | null>(() => null);
/** What `authEndpointTemplates` reads of a Better Auth endpoint. */
interface AuthEndpoint {
  readonly path?: string;
  readonly options?: {
    readonly method?: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

/**
 * The endpoints Better Auth's router serves under `/api/auth`, by template, such as
 * `/api/auth/sign-in/social` or `/api/auth/sso/callback/:providerId`. Request spans record the
 * template of the endpoint a path reaches, or the `/api/auth/*` wildcard for a path none serves:
 * an SSO provider's ID is chosen by an organization's administrator, and an unknown path by its
 * caller (`routeTemplates` in `@executor-js/telemetry`).
 */
export const authEndpointTemplates = (api: Readonly<Record<string, AuthEndpoint>>) =>
  Object.values(api).flatMap((endpoint) =>
    endpoint.path === undefined || endpoint.options?.metadata?.["SERVER_ONLY"] === true
      ? []
      : [`/api/auth${endpoint.path}` as const],
  );

const loopback = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
};

/** A redirect URI as a client identity: native clients listen on a new loopback port each time. */
const redirectIdentity = (value: string) => {
  if (!loopback(value)) return value;
  const url = new URL(value);
  url.port = "";
  return url.href;
};

/** Hosts select and authorize their own resource (an organization for hosted, an instance for local). */
/** Why Better Auth refused a refresh grant, and when the presented token was revoked. */
export type RefreshRejection = Parameters<
  NonNullable<OAuthOptions<Scope[]>["onRefreshRejected"]>
>[0];
export interface GrantOAuthOptions {
  /** The browser origin that serves sign-in and consent; same-origin checks compare against it. */
  readonly origin: string;
  /** Where the MCP and API resources that tokens are issued for are served. */
  readonly resourceOrigins: ResourceOrigins;
  /**
   * The authorization server's issuer identifier, exact and without a trailing slash. It may
   * name another host than `origin` (RFC 8414): metadata, `iss` and introspection name it, while
   * every endpoint stays on `origin`. Hosts that serve one origin use `${origin}/api/auth`.
   */
  readonly issuer: string;
  /**
   * Choose and authorize the consent's resource. A scoped connection fixes it as `required`;
   * the host still checks access and rejects a conflicting explicit choice.
   */
  readonly selectResource: (
    context: GenericEndpointContext,
    userId: string,
    required?: string,
  ) => Effect.Effect<string, APIError>;
  readonly checkResource: (
    context: GenericEndpointContext,
    userId: string,
    resource: string,
  ) => Effect.Effect<void, APIError>;
  readonly resources: NonNullable<OAuthOptions<Scope[]>["resources"]>;
  readonly scopes: Scope[];
  /** Observe why a refresh grant was refused, including reuse detection revoking its family. */
  readonly onRefreshRejected?: ((rejection: RefreshRejection) => void) | undefined;
  /**
   * Offer RFC 8628 device authorization, approved on the browser origin's verification page.
   * Only hosts that serve that page and a signed-in browser session enable it.
   */
  readonly deviceAuthorization: boolean;
}
const accessTokenSeconds = 3600;
/** Better Auth's default refresh token lifetime, stated because idle grant expiry follows it. */
const refreshTokenSeconds = 30 * 24 * 3600;
/** How long after rotation a stale copy is refused without revoking its family. */
const supersededRefreshSeconds = 24 * 3600;
/** Why a grant was or was not expired; see `idleGrants`. */
export const GrantExpiryOutcome = Schema.Literals([
  /** Revoked now: no usable token and idle for the whole window. */
  "revoked",
  /** A report found it idle; applying would revoke it. */
  "idle",
  /** It holds an unexpired, unrevoked token. */
  "live",
  /** A consent, token issue or rotation falls inside the window. */
  "recent",
  /** No consent row, so its age is unknown; it may still be being written. */
  "unconsented",
  /** Missing or already revoked. */
  "absent",
]);
export type GrantExpiryOutcome = typeof GrantExpiryOutcome.Type;
const GrantExpiryResults = Schema.Struct({
  grants: Schema.Array(Schema.Struct({ id: GrantId, outcome: GrantExpiryOutcome })),
});
const GrantPage = Schema.Struct({
  grants: Schema.Array(Schema.Struct({ id: GrantId, userId: Schema.NonEmptyString })),
});
/** The most grants one expiry call lists or checks. */
const grantBatch = 200;
/** Missing grant records fail closed, including credentials issued before this plugin was installed. */
export const grantOAuthPlugins = (settings: GrantOAuthOptions) => {
  const { origin, resourceOrigins } = settings;
  const options = {
    issuer: settings.issuer,
    scopes: settings.scopes,
    resources: settings.resources,
    resourceSeedMode: "manual",
    clientRegistrationDefaultResources: settings.resources.map((resource) =>
      typeof resource === "string" ? resource : resource.identifier,
    ),
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationRequirePKCE: true,
    grantTypes: ["authorization_code", "refresh_token"],
    disableJwtPlugin: true,
    accessTokenExpiresIn: accessTokenSeconds,
    refreshTokenExpiresIn: refreshTokenSeconds,
    // MCP clients often run several instances from one stored grant, each refreshing its own
    // copy. A sibling presenting a token rotated while that rotation's access token is still
    // live receives the same response instead of revoking every token for the client and user.
    refreshTokenReuseInterval: accessTokenSeconds,
    // An idle instance can hold a copy rotated hours ago and present it when it closes or
    // reconnects; Codex does so without rereading the shared store. Refuse that copy alone for a
    // day after its rotation. Later reuse, or reuse of a revoked token, still revokes the family.
    refreshTokenSupersededInterval: supersededRefreshSeconds,
    ...(settings.onRefreshRejected === undefined
      ? {}
      : { onRefreshRejected: settings.onRefreshRejected }),
    loginPage: "/mcp/authorize",
    consentPage: "/mcp/authorize",
    clientPrivileges: () => false,
    resourcePrivileges: () => false,
    postLogin: {
      page: "/mcp/authorize",
      shouldRedirect: () =>
        runAuth(authCall(() => selected.get()).pipe(Effect.map((s) => s === null))),
      consentReferenceId: ({ user }) =>
        runAuth(
          Effect.gen(function* () {
            const s = yield* authCall(() => selected.get());
            if (s === null || s.userId !== user.id)
              return yield* Effect.fail(new APIError("FORBIDDEN"));
            return s.id;
          }),
        ),
    },
    customAccessTokenClaims: ({ referenceId }) => ({ grant_id: referenceId }),
    // Connections add resources after clients register. Every resource here is an Executor
    // audience, and grants still bind each token to exactly one of them.
    enforcePerClientResources: false,
  } satisfies OAuthOptions<Scope[]>;
  /** Insert a connection's missing resources at every MCP origin; existing rows are kept. */
  const seedConnectionResources = (context: OAuthResourceSeedContext, connection: ConnectionId) =>
    seedOAuthResources(context, {
      ...options,
      resources: mcpOAuthResources(resourceOrigins.mcp, connection),
    });
  const get = (context: GenericEndpointContext, id: GrantId) =>
    authCall(() =>
      context.context.adapter.findOne({ model: "mcpGrant", where: [{ field: "id", value: id }] }),
    ).pipe(
      Effect.flatMap((row) => Schema.decodeUnknownEffect(Record)(row)),
      Effect.mapError((error) => (isAPIError(error) ? error : new APIError("UNAUTHORIZED"))),
      Effect.flatMap((row) =>
        row.revoked ? Effect.fail(new APIError("UNAUTHORIZED")) : Effect.succeed(row),
      ),
    );
  const findConnection = (context: GenericEndpointContext, id: ConnectionId) =>
    authCall(() =>
      context.context.adapter.findOne({
        model: "mcpConnection",
        where: [{ field: "id", value: id }],
      }),
    ).pipe(
      Effect.flatMap((row) =>
        row === null
          ? Effect.succeed(undefined)
          : parse(ConnectionRecord, row).pipe(
              Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
            ),
      ),
    );
  /** Missing, revoked, or someone else's connections are all the same absence. */
  const ownedConnection = (
    context: GenericEndpointContext,
    owner: { readonly userId: string; readonly resource?: string },
    id: ConnectionId,
  ) =>
    findConnection(context, id).pipe(
      Effect.flatMap((row) =>
        row === undefined ||
        row.revoked ||
        row.userId !== owner.userId ||
        (owner.resource !== undefined && row.resource !== owner.resource)
          ? Effect.fail(new APIError("NOT_FOUND"))
          : Effect.succeed(row),
      ),
    );
  const connectionPolicy = (row: typeof ConnectionRecord.Type) =>
    parse(Schema.fromJsonString(ConnectionPolicy), row.policy).pipe(
      Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
    );
  const connectionView = (row: typeof ConnectionRecord.Type) =>
    connectionPolicy(row).pipe(
      Effect.map((policy) =>
        Connection.make({
          id: row.id,
          name: row.name,
          policy,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }),
      ),
    );
  /** A connection grant has no authority of its own; it reads the connection on every use. */
  const currentPolicy = (
    context: GenericEndpointContext,
    row: typeof Record.Type,
    target: GrantTarget,
  ) =>
    Effect.gen(function* () {
      const connection = row.connection ?? undefined;
      const requested = target.kind === "mcp" ? target.connection : undefined;
      if (connection !== requested) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
      if (connection === undefined)
        return yield* parse(Schema.fromJsonString(GrantPolicy), row.policy);
      const current = yield* ownedConnection(
        context,
        { userId: row.userId, resource: row.resource },
        connection,
      );
      return connectionGrantPolicy(yield* connectionPolicy(current));
    }).pipe(
      Effect.mapError((error) => (error.statusCode === 503 ? error : new APIError("UNAUTHORIZED"))),
    );
  const project = (context: GenericEndpointContext, row: typeof Record.Type, target: GrantTarget) =>
    currentPolicy(context, row, target).pipe(
      Effect.map((policy) =>
        GrantAccess.make({
          userId: row.userId,
          clientId: row.clientId,
          resource: row.resource,
          grant: { id: row.id, policy, target },
        }),
      ),
    );
  /** A same-origin request with the signed-in browser's cookie; never a bearer credential. */
  const browserSession = (context: GenericEndpointContext) =>
    Effect.gen(function* () {
      if (
        context.headers?.has("authorization") ||
        context.headers?.get("sec-fetch-site") === "cross-site" ||
        (context.headers?.has("origin") && context.headers.get("origin") !== origin) ||
        (context.request?.method !== "GET" && context.headers?.get("origin") !== origin)
      )
        return yield* Effect.fail(new APIError("FORBIDDEN"));
      const session = yield* authCall(() => getSessionFromCtx(context));
      if (session === null) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
      return { userId: session.user.id, sessionId: session.session.id };
    });
  const browser = (context: GenericEndpointContext) =>
    browserSession(context).pipe(Effect.map((session) => session.userId));
  /** The consent's one resource and what it names; its tokens carry exactly that audience. */
  const consentTarget = (value: unknown) =>
    parse(Schema.Struct({ resources: Schema.Array(Schema.String) }), value).pipe(
      Effect.flatMap(({ resources }) => {
        const target = grantTarget(resourceOrigins, resources);
        return target === undefined || resources[0] === undefined
          ? Effect.fail(new APIError("UNAUTHORIZED"))
          : Effect.succeed({ target, resource: resources[0] });
      }),
      Effect.mapError(() => new APIError("UNAUTHORIZED")),
    );
  const consentFor = (context: GenericEndpointContext, row: typeof Record.Type) =>
    authCall(() =>
      context.context.adapter.findOne({
        model: "oauthConsent",
        where: [
          { field: "userId", value: row.userId },
          { field: "clientId", value: row.clientId },
          { field: "referenceId", value: row.id },
        ],
      }),
    ).pipe(Effect.flatMap(consentTarget));
  const targetFor = (context: GenericEndpointContext, row: typeof Record.Type) =>
    consentFor(context, row).pipe(Effect.map(({ target }) => target));
  /** Consent and narrowing refuse a policy that even the grant's own URL could not serve. */
  const requireServable = (policy: GrantPolicy, target: GrantTarget) =>
    approvalRefusal(policy, target) === undefined
      ? Effect.void
      : Effect.fail(
          new APIError("FORBIDDEN", {
            message:
              "Browser approval needs a grant issued at an MCP URL with elicitation_mode=browser.",
          }),
        );
  const access = (context: GenericEndpointContext, kind: "mcp" | "api") =>
    Effect.gen(function* () {
      const token = context.headers?.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (token === undefined) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
      const payload = yield* authCall(() =>
        Promise.resolve(getOAuthProviderApi(context, options).requireActiveAccessToken(token)),
      );
      const claims = yield* Schema.decodeUnknownEffect(Claims)(payload).pipe(
        Effect.mapError(() => new APIError("UNAUTHORIZED")),
      );
      if (claims.cnf !== undefined) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
      const row = yield* get(context, claims.grant_id);
      if (row.userId !== claims.sub || row.clientId !== claims.client_id)
        return yield* Effect.fail(new APIError("UNAUTHORIZED"));
      const { target, resource } = yield* consentFor(context, row);
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (
        audiences.length !== 1 ||
        audiences[0] !== resource ||
        target.kind !== kind ||
        !claims.scope.split(" ").includes(kind === "api" ? "executor" : "mcp")
      )
        return yield* Effect.fail(new APIError("UNAUTHORIZED"));
      yield* settings.checkResource(context, row.userId, row.resource);
      return yield* project(context, row, target);
    });
  const revoke = (ctx: GenericEndpointContext, id: GrantId) =>
    Effect.gen(function* () {
      yield* authCall(() =>
        ctx.context.adapter.update({
          model: "mcpGrant",
          where: [{ field: "id", value: id }],
          update: { revoked: true },
        }),
      );
      for (const model of ["oauthAccessToken", "oauthRefreshToken"])
        yield* authCall(() =>
          ctx.context.adapter.deleteMany({ model, where: [{ field: "referenceId", value: id }] }),
        );
    });
  /** New grants and tokens for a revoked connection fail; its grants lose their tokens now. */
  const revokeConnection = (ctx: GenericEndpointContext, row: typeof ConnectionRecord.Type) =>
    Effect.gen(function* () {
      yield* authCall(() =>
        ctx.context.adapter.update({
          model: "mcpConnection",
          where: [{ field: "id", value: row.id }],
          update: { revoked: true, updatedAt: new Date() },
        }),
      );
      yield* authCall(() =>
        ctx.context.adapter.updateMany({
          model: "oauthResource",
          where: [
            {
              field: "identifier",
              operator: "in",
              value: mcpOAuthResources(resourceOrigins.mcp, row.id).map((item) => item.identifier),
            },
          ],
          update: { disabled: true },
        }),
      );
      const grants = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "mcpGrant",
          where: [
            { field: "connection", value: row.id },
            { field: "userId", value: row.userId },
          ],
        }),
      ).pipe(Effect.flatMap((rows) => parse(Schema.Array(Record), rows)));
      yield* Effect.forEach(grants, (grant) => revoke(ctx, grant.id), { discard: true });
    });
  const serverOnly = { method: "POST", metadata: { SERVER_ONLY: true } } as const;
  /**
   * Grants that still hold a token Better Auth would accept: an unexpired, unrevoked access
   * token, or an unexpired, unrevoked refresh token that can mint one. Rotated refresh tokens are
   * revoked and only replay their successor, so they never count. Tokens name the approving
   * browser session while it exists and are refused once it expires. Signing out deletes it:
   * Better Auth revokes its access tokens and detaches its `offline_access` refresh tokens,
   * which then keep working.
   */
  const usableGrants = (ctx: GenericEndpointContext, ids: readonly GrantId[]) =>
    Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis);
      const Live = Schema.Array(
        Schema.Struct({
          referenceId: GrantId,
          sessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      );
      const live = (model: "oauthAccessToken" | "oauthRefreshToken") =>
        authCall(() =>
          ctx.context.adapter.findMany({
            model,
            where: [
              { field: "referenceId", operator: "in", value: [...ids] },
              { field: "expiresAt", operator: "gt", value: now },
              { field: "revoked", operator: "eq", value: null },
            ],
          }),
        ).pipe(Effect.flatMap((rows) => parse(Live, rows)));
      const tokens = [...(yield* live("oauthAccessToken")), ...(yield* live("oauthRefreshToken"))];
      const sessionIds = [
        ...new Set(tokens.flatMap((token) => (token.sessionId == null ? [] : [token.sessionId]))),
      ];
      const sessions =
        sessionIds.length === 0
          ? []
          : yield* authCall(() =>
              ctx.context.adapter.findMany({
                model: "session",
                where: [
                  { field: "id", operator: "in", value: sessionIds },
                  { field: "expiresAt", operator: "gt", value: now },
                ],
              }),
            ).pipe(
              Effect.flatMap((rows) =>
                parse(Schema.Array(Schema.Struct({ id: Schema.String })), rows),
              ),
            );
      const liveSessions = new Set(sessions.map((session) => session.id));
      return new Set(
        tokens.flatMap((token) =>
          token.sessionId == null || liveSessions.has(token.sessionId) ? [token.referenceId] : [],
        ),
      );
    });
  /**
   * Why each grant is or is not idle since `since`. A grant receives tokens only by exchanging a
   * code issued with its own consent, which lasts ten minutes, or by refreshing one of its own
   * unexpired, unrevoked refresh tokens: each authorization creates a new grant. A grant with no
   * such token, whose consent and every token issue and rotation precede `since`, can never be
   * used again. Any unexpired, unrevoked token keeps a grant live, whatever its session, so
   * nothing Better Auth might still accept is expired. A rotation revokes the old refresh token
   * before it stores the new one; the rotation's own time keeps that grant recent meanwhile.
   */
  const idleGrants = (ctx: GenericEndpointContext, ids: readonly GrantId[], since: Date) =>
    Effect.gen(function* () {
      const outcome = new Map<GrantId, "idle" | "live" | "recent" | "unconsented">();
      if (ids.length === 0) return outcome;
      const now = new Date(yield* Clock.currentTimeMillis);
      const References = Schema.Array(Schema.Struct({ referenceId: GrantId }));
      const live = (model: "oauthAccessToken" | "oauthRefreshToken") =>
        authCall(() =>
          ctx.context.adapter.findMany({
            model,
            where: [
              { field: "referenceId", operator: "in", value: [...ids] },
              { field: "expiresAt", operator: "gt", value: now },
              { field: "revoked", operator: "eq", value: null },
            ],
          }),
        ).pipe(Effect.flatMap((rows) => parse(References, rows)));
      const held = new Set(
        [...(yield* live("oauthAccessToken")), ...(yield* live("oauthRefreshToken"))].map(
          (token) => token.referenceId,
        ),
      );
      const consents = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "oauthConsent",
          where: [{ field: "referenceId", operator: "in", value: [...ids] }],
        }),
      ).pipe(
        Effect.flatMap((rows) =>
          parse(
            Schema.Array(
              Schema.Struct({
                referenceId: GrantId,
                createdAt: Schema.Date,
                updatedAt: Schema.Date,
              }),
            ),
            rows,
          ),
        ),
      );
      const consentOf = new Map(consents.map((consent) => [consent.referenceId, consent]));
      // One row in the window is enough, so each check reads at most one.
      const touched = (id: GrantId) =>
        Effect.gen(function* () {
          for (const [model, field] of [
            ["oauthAccessToken", "createdAt"],
            ["oauthRefreshToken", "createdAt"],
            ["oauthRefreshToken", "revoked"],
          ] as const) {
            const rows = yield* authCall(() =>
              ctx.context.adapter.findMany({
                model,
                where: [
                  { field: "referenceId", value: id },
                  { field, operator: "gte", value: since },
                ],
                limit: 1,
              }),
            );
            if (rows.length > 0) return true;
          }
          return false;
        });
      yield* Effect.forEach(
        ids,
        (id) =>
          Effect.gen(function* () {
            const consent = consentOf.get(id);
            if (held.has(id)) return outcome.set(id, "live");
            // The consent is written after its grant, so a grant without one may be mid-consent.
            if (consent === undefined) return outcome.set(id, "unconsented");
            if (consent.createdAt >= since || consent.updatedAt >= since || (yield* touched(id)))
              return outcome.set(id, "recent");
            return outcome.set(id, "idle");
          }),
        { concurrency: 4, discard: true },
      );
      return outcome;
    });
  /** Check the given unrevoked grants and, when applying, revoke those idle for 30 days. */
  const expireIdle = (ctx: GenericEndpointContext, ids: readonly GrantId[], apply: boolean) =>
    Effect.gen(function* () {
      if (ids.length === 0) return [];
      const rows = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "mcpGrant",
          where: [
            { field: "id", operator: "in", value: [...ids] },
            { field: "revoked", value: false },
          ],
        }),
      ).pipe(Effect.flatMap((rows) => parse(Schema.Array(Record), rows)));
      const now = yield* Clock.currentTimeMillis;
      const checked = yield* idleGrants(
        ctx,
        rows.map((row) => row.id),
        new Date(now - refreshTokenSeconds * 1000),
      );
      return yield* Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          const found = checked.get(id);
          if (found === undefined) return { id, outcome: "absent" as const };
          if (found !== "idle") return { id, outcome: found };
          if (!apply) return { id, outcome: "idle" as const };
          yield* revoke(ctx, id);
          return { id, outcome: "revoked" as const };
        }),
      );
    });
  /**
   * When a user authorizes a client, revoke their idle grants for the same organization and URL
   * from the same client: the same registration or a re-registration of it. MCP clients that lose
   * their credentials register again under a new client ID, so two registrations match when both
   * declare the same name, software ID and redirect URIs, ignoring loopback ports, which native
   * clients choose afresh. Names are self-declared, but only grants that can never be used again
   * are revoked, and only once idle for an hour: past the code lifetime and the refresh reuse
   * window, so a sibling authorization or refresh in flight is never cut off.
   */
  const retireReplaced = (
    ctx: GenericEndpointContext,
    created: typeof Record.Type,
    resources: readonly string[],
  ) =>
    Effect.gen(function* () {
      const siblings = (yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "mcpGrant",
          where: [
            { field: "userId", value: created.userId },
            { field: "resource", value: created.resource },
            { field: "revoked", value: false },
          ],
        }),
      ).pipe(Effect.flatMap((rows) => parse(Schema.Array(Record), rows)))).filter(
        (grant) => grant.id !== created.id,
      );
      if (siblings.length === 0) return;
      const clients = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "oauthClient",
          where: [
            {
              field: "clientId",
              operator: "in",
              value: [...new Set([created.clientId, ...siblings.map((grant) => grant.clientId)])],
            },
          ],
        }),
      ).pipe(
        Effect.flatMap((rows) =>
          parse(
            Schema.Array(
              Schema.Struct({
                clientId: Schema.String,
                name: Schema.optionalKey(Schema.NullOr(Schema.String)),
                softwareId: Schema.optionalKey(Schema.NullOr(Schema.String)),
                redirectUris: Schema.Array(Schema.String),
              }),
            ),
            rows,
          ),
        ),
      );
      const identity = new Map(
        clients.flatMap((client) => {
          const name = client.name?.trim();
          if (!name) return [];
          const redirects = [...new Set(client.redirectUris.map(redirectIdentity))].sort();
          return [[client.clientId, JSON.stringify([name, client.softwareId ?? null, redirects])]];
        }),
      );
      const own = identity.get(created.clientId);
      const consents = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "oauthConsent",
          where: [
            { field: "userId", value: created.userId },
            { field: "referenceId", operator: "in", value: siblings.map((grant) => grant.id) },
          ],
        }),
      ).pipe(
        Effect.flatMap((rows) =>
          parse(
            Schema.Array(
              Schema.Struct({
                referenceId: GrantId,
                resources: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
              }),
            ),
            rows,
          ),
        ),
      );
      const url = [...new Set(resources)].sort().join(" ");
      const sameUrl = new Set(
        consents.flatMap((consent) =>
          [...new Set(consent.resources ?? [])].sort().join(" ") === url
            ? [consent.referenceId]
            : [],
        ),
      );
      const replaced = siblings.filter(
        (grant) =>
          sameUrl.has(grant.id) &&
          (grant.clientId === created.clientId ||
            (own !== undefined && identity.get(grant.clientId) === own)),
      );
      const now = yield* Clock.currentTimeMillis;
      const checked = yield* idleGrants(
        ctx,
        replaced.map((grant) => grant.id),
        new Date(now - accessTokenSeconds * 1000),
      );
      for (const [id, outcome] of checked) if (outcome === "idle") yield* revoke(ctx, id);
    });
  /**
   * The owner's grants that hold a usable token, with their client, consent time and newest
   * access token, most recently used first. Grants without a usable token, a readable consent or
   * their connection authorize nothing and are omitted; idle ones are revoked by `expireIdle`.
   */
  const listAgents = (
    ctx: GenericEndpointContext,
    owner: { readonly userId: string; readonly resource: string },
  ) =>
    Effect.gen(function* () {
      const unavailable = () => new APIError("SERVICE_UNAVAILABLE");
      const grants = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "mcpGrant",
          where: [
            { field: "userId", value: owner.userId },
            { field: "resource", value: owner.resource },
            { field: "revoked", value: false },
          ],
        }),
      ).pipe(Effect.flatMap((rows) => parse(Schema.Array(Record), rows)));
      if (grants.length === 0) return [];
      const consents = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "oauthConsent",
          where: [
            { field: "userId", value: owner.userId },
            { field: "referenceId", operator: "in", value: grants.map((grant) => grant.id) },
          ],
        }),
      ).pipe(
        Effect.flatMap((rows) =>
          parse(
            Schema.Array(
              Schema.Struct({
                referenceId: GrantId,
                resources: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
                createdAt: Schema.Date,
              }),
            ),
            rows,
          ),
        ),
        Effect.mapError(unavailable),
      );
      const clients = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "oauthClient",
          where: [
            {
              field: "clientId",
              operator: "in",
              value: [...new Set(grants.map((grant) => grant.clientId))],
            },
          ],
        }),
      ).pipe(
        Effect.flatMap((rows) =>
          parse(
            Schema.Array(
              Schema.Struct({
                clientId: Schema.String,
                name: Schema.optionalKey(Schema.NullOr(Schema.String)),
                disabled: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
              }),
            ),
            rows,
          ),
        ),
        Effect.mapError(unavailable),
      );
      const connectionIds = [
        ...new Set(grants.flatMap((grant) => (grant.connection == null ? [] : [grant.connection]))),
      ];
      const connections =
        connectionIds.length === 0
          ? []
          : yield* authCall(() =>
              ctx.context.adapter.findMany({
                model: "mcpConnection",
                where: [{ field: "id", operator: "in", value: connectionIds }],
              }),
            ).pipe(
              Effect.flatMap((rows) => parse(Schema.Array(ConnectionRecord), rows)),
              Effect.mapError(unavailable),
            );
      const usable = yield* usableGrants(
        ctx,
        grants.map((grant) => grant.id),
      ).pipe(Effect.mapError(unavailable));
      const consentOf = new Map(consents.map((consent) => [consent.referenceId, consent]));
      const nameOf = new Map(clients.map((client) => [client.clientId, client.name ?? null]));
      const disabled = new Set(
        clients.flatMap((client) => (client.disabled === true ? [client.clientId] : [])),
      );
      const connectionOf = new Map(connections.map((row) => [row.id, row]));
      const agents = yield* Effect.forEach(
        grants,
        (grant) =>
          Effect.gen(function* () {
            if (!usable.has(grant.id) || disabled.has(grant.clientId)) return [];
            const consent = consentOf.get(grant.id);
            const target =
              consent === undefined
                ? undefined
                : grantTarget(resourceOrigins, consent.resources ?? []);
            if (consent === undefined || target === undefined) return [];
            const connection =
              grant.connection == null ? undefined : connectionOf.get(grant.connection);
            if (
              grant.connection != null &&
              (connection === undefined ||
                connection.revoked ||
                connection.userId !== grant.userId ||
                connection.resource !== grant.resource)
            )
              return [];
            const policy =
              connection === undefined
                ? yield* parse(Schema.fromJsonString(GrantPolicy), grant.policy).pipe(
                    Effect.mapError(unavailable),
                  )
                : undefined;
            const access: ConnectedAgentAccess =
              target.kind === "api"
                ? { kind: "api" }
                : connection !== undefined
                  ? { kind: "connection", connection: connection.id, name: connection.name }
                  : policy?.kind === "tools"
                    ? { kind: "tools", apps: policy.apps.length }
                    : { kind: "all" };
            const latest = yield* authCall(() =>
              ctx.context.adapter.findMany({
                model: "oauthAccessToken",
                where: [{ field: "referenceId", value: grant.id }],
                sortBy: { field: "createdAt", direction: "desc" },
                limit: 1,
              }),
            ).pipe(
              Effect.flatMap((rows) =>
                parse(Schema.Array(Schema.Struct({ createdAt: Schema.Date })), rows),
              ),
              Effect.mapError(unavailable),
            );
            return [
              ConnectedAgent.make({
                id: grant.id,
                name: nameOf.get(grant.clientId) ?? null,
                connectedAt: consent.createdAt.toISOString(),
                lastActiveAt: latest[0]?.createdAt.toISOString() ?? null,
                access,
                ...(target.kind === "mcp" ? { mode: target.mode } : {}),
              }),
            ];
          }),
        { concurrency: 4 },
      );
      return agents
        .flat()
        .sort(
          (a, b) =>
            (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? "") ||
            b.connectedAt.localeCompare(a.connectedAt),
        );
    });
  const lookupBrowser = (ctx: GenericEndpointContext) =>
    Effect.gen(function* () {
      const userId = yield* browser(ctx);
      const { id } = yield* parse(Schema.Struct({ id: GrantId }), ctx.body);
      const row = yield* get(ctx, id);
      if (row.userId !== userId) return yield* Effect.fail(new APIError("FORBIDDEN"));
      yield* settings.checkResource(ctx, userId, row.resource);
      return yield* project(ctx, row, yield* targetFor(ctx, row));
    });
  /**
   * The grant one approval authorizes: its resource, policy and organization. Consent and device
   * approval both create grants here, so their tokens carry the same authority.
   */
  const createGrant = (
    ctx: GenericEndpointContext,
    userId: string,
    clientId: string,
    resources: readonly string[],
  ) =>
    Effect.gen(function* () {
      const target = grantTarget(resourceOrigins, resources);
      if (target === undefined)
        return yield* Effect.fail(
          new APIError("BAD_REQUEST", {
            message: "Choose one Executor connection URL and try again.",
          }),
        );
      const policyHeader = ctx.headers?.get("x-executor-grant");
      const connection =
        target.kind === "mcp" && target.connection !== undefined
          ? yield* ownedConnection(ctx, { userId }, target.connection).pipe(
              Effect.mapError(
                (error) =>
                  new APIError(error.statusCode === 503 ? "SERVICE_UNAVAILABLE" : "FORBIDDEN", {
                    message: "This connection is no longer available.",
                  }),
              ),
            )
          : undefined;
      // A connection's access comes from its record; the consent page cannot widen it.
      if (connection !== undefined && policyHeader !== null && policyHeader !== undefined)
        return yield* Effect.fail(new APIError("BAD_REQUEST"));
      const policy =
        connection !== undefined
          ? connectionGrantPlaceholder
          : policyHeader === null || policyHeader === undefined
            ? GrantPolicy.make({ kind: "all" })
            : yield* parse(Schema.fromJsonString(GrantPolicy), policyHeader);
      yield* requireServable(policy, target);
      const resource = yield* settings.selectResource(ctx, userId, connection?.resource);
      const row = yield* authCall(() =>
        ctx.context.adapter.create({
          model: "mcpGrant",
          data: {
            userId,
            clientId,
            resource,
            policy: JSON.stringify(policy),
            revoked: false,
            ...(connection === undefined ? {} : { connection: connection.id }),
          },
        }),
      );
      const grant = yield* parse(Record, row);
      // Cleanup must not block the authorization; daily expiry retries what fails here.
      yield* retireReplaced(ctx, grant, resources).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Replaced agent grants were not revoked", cause),
        ),
      );
      return grant;
    });
  /**
   * Device approval records the consent that authorization codes record for themselves, so its
   * tokens resolve their grant and audience the same way.
   */
  const device = deviceAuthorizationPlugin({
    origin,
    provider: options,
    accepts: (resource) => grantTarget(resourceOrigins, [resource]) !== undefined,
    session: browserSession,
    approve: (ctx, request) =>
      Effect.gen(function* () {
        const grant = yield* createGrant(ctx, request.userId, request.clientId, [request.resource]);
        const now = yield* Clock.currentTimeMillis;
        yield* authCall(() =>
          ctx.context.adapter.create({
            model: "oauthConsent",
            data: {
              clientId: request.clientId,
              userId: request.userId,
              scopes: [...request.scopes],
              resources: [request.resource],
              referenceId: grant.id,
              createdAt: new Date(now),
              updatedAt: new Date(now),
            },
          }),
        );
        return grant.id;
      }),
    revoke,
  });
  const plugin = {
    id: "executor-grants",
    schema: {
      mcpGrant: {
        fields: {
          userId: {
            type: "string",
            required: true,
            references: { model: "user", field: "id", onDelete: "cascade" },
          },
          clientId: { type: "string", required: true },
          resource: { type: "string", required: true },
          policy: { type: "string", required: true },
          revoked: { type: "boolean", required: true, defaultValue: false },
          // Nullable and unreferenced so existing grant rows keep their own policy unchanged.
          // Better Auth adds columns before creating tables, so a foreign key could not apply.
          connection: { type: "string", required: false },
        },
      },
      mcpConnection: {
        fields: {
          userId: {
            type: "string",
            required: true,
            references: { model: "user", field: "id", onDelete: "cascade" },
          },
          resource: { type: "string", required: true },
          name: { type: "string", required: true },
          policy: { type: "string", required: true },
          revoked: { type: "boolean", required: true, defaultValue: false },
          createdAt: { type: "date", required: true },
          updatedAt: { type: "date", required: true },
        },
      },
    },
    endpoints: {
      getMcpGrantAccess: createAuthEndpoint(
        "/mcp/grant-access",
        { method: "GET", requireHeaders: true, metadata: { SERVER_ONLY: true } },
        (ctx) => runAuth(access(ctx, "mcp")),
      ),
      getApiGrantAccess: createAuthEndpoint(
        "/api/grant-access",
        { method: "GET", requireHeaders: true, metadata: { SERVER_ONLY: true } },
        (ctx) => runAuth(access(ctx, "api")),
      ),
      /**
       * A grant's current authority, without a credential: for background work saved under it,
       * such as an event subscription. A revoked or deleted grant fails as unauthorized.
       */
      getMcpGrant: createAuthEndpoint(
        "/mcp/grant",
        {
          method: "POST",
          body: Schema.toStandardSchemaV1(Schema.Struct({ id: GrantId })),
          metadata: { SERVER_ONLY: true },
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const row = yield* get(ctx, ctx.body.id);
              yield* settings.checkResource(ctx, row.userId, row.resource);
              return yield* project(ctx, row, yield* targetFor(ctx, row));
            }),
          ),
      ),
      getBrowserGrant: createAuthEndpoint(
        "/mcp/browser-grant",
        {
          method: "POST",
          requireHeaders: true,
          body: Schema.toStandardSchemaV1(Schema.Struct({ id: GrantId })),
          metadata: { SERVER_ONLY: true },
        },
        (ctx) => runAuth(lookupBrowser(ctx)),
      ),
      listMcpConnections: createAuthEndpoint(
        "/mcp/connections/list",
        { ...serverOnly, body: Schema.toStandardSchemaV1(Schema.Struct(ConnectionOwner)) },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const rows = yield* authCall(() =>
                ctx.context.adapter.findMany({
                  model: "mcpConnection",
                  where: [
                    { field: "userId", value: ctx.body.userId },
                    { field: "resource", value: ctx.body.resource },
                    { field: "revoked", value: false },
                  ],
                  sortBy: { field: "createdAt", direction: "asc" },
                }),
              ).pipe(Effect.flatMap((rows) => parse(Schema.Array(ConnectionRecord), rows)));
              return yield* Effect.forEach(rows, connectionView);
            }),
          ),
      ),
      createMcpConnection: createAuthEndpoint(
        "/mcp/connections/create",
        {
          ...serverOnly,
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              ...ConnectionOwner,
              id: ConnectionId,
              name: ConnectionName,
              policy: ConnectionPolicy,
            }),
          ),
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const input = ctx.body;
              const existing = yield* findConnection(ctx, input.id);
              // The client chose this ID for one editor, so a retry returns the first result.
              if (existing !== undefined)
                return existing.userId === input.userId &&
                  existing.resource === input.resource &&
                  !existing.revoked
                  ? yield* connectionView(existing)
                  : yield* Effect.fail(new APIError("CONFLICT"));
              // Resources exist before the URL is shown, so the first authorization can use it.
              yield* authCall(() => seedConnectionResources(ctx.context, input.id));
              const now = new Date();
              const row = yield* authCall(() =>
                ctx.context.adapter.create({
                  model: "mcpConnection",
                  forceAllowId: true,
                  data: {
                    id: input.id,
                    userId: input.userId,
                    resource: input.resource,
                    name: input.name,
                    policy: JSON.stringify(input.policy),
                    revoked: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                }),
              ).pipe(Effect.flatMap((row) => parse(ConnectionRecord, row)));
              return yield* connectionView(row);
            }),
          ),
      ),
      updateMcpConnection: createAuthEndpoint(
        "/mcp/connections/update",
        {
          ...serverOnly,
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              ...ConnectionOwner,
              id: ConnectionId,
              name: ConnectionName,
              policy: ConnectionPolicy,
            }),
          ),
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const input = ctx.body;
              yield* ownedConnection(ctx, input, input.id);
              // Connected agents read this record on their next request.
              const row = yield* authCall(() =>
                ctx.context.adapter.update({
                  model: "mcpConnection",
                  where: [
                    { field: "id", value: input.id },
                    { field: "revoked", value: false },
                  ],
                  update: {
                    name: input.name,
                    policy: JSON.stringify(input.policy),
                    updatedAt: new Date(),
                  },
                }),
              );
              if (row === null) return yield* Effect.fail(new APIError("NOT_FOUND"));
              return yield* connectionView(yield* parse(ConnectionRecord, row));
            }),
          ),
      ),
      revokeMcpConnection: createAuthEndpoint(
        "/mcp/connections/revoke",
        {
          ...serverOnly,
          body: Schema.toStandardSchemaV1(Schema.Struct({ ...ConnectionOwner, id: ConnectionId })),
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const row = yield* ownedConnection(ctx, ctx.body, ctx.body.id);
              yield* revokeConnection(ctx, row);
              return { revoked: true };
            }),
          ),
      ),
      listMcpAgents: createAuthEndpoint(
        "/mcp/agents/list",
        { ...serverOnly, body: Schema.toStandardSchemaV1(Schema.Struct(ConnectionOwner)) },
        (ctx) => runAuth(listAgents(ctx, ctx.body)),
      ),
      revokeMcpAgent: createAuthEndpoint(
        "/mcp/agents/revoke",
        {
          ...serverOnly,
          body: Schema.toStandardSchemaV1(Schema.Struct({ ...ConnectionOwner, id: GrantId })),
        },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const row = yield* get(ctx, ctx.body.id).pipe(
                Effect.mapError((error) =>
                  error.statusCode === 503 ? error : new APIError("NOT_FOUND"),
                ),
              );
              if (row.userId !== ctx.body.userId || row.resource !== ctx.body.resource)
                return yield* Effect.fail(new APIError("NOT_FOUND"));
              yield* revoke(ctx, row.id);
              return { revoked: true };
            }),
          ),
      ),
      listMcpGrantIds: createAuthEndpoint(
        "/mcp/grants/ids",
        {
          ...serverOnly,
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              after: Schema.NullOr(GrantId),
              limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: grantBatch })),
            }),
          ),
        },
        (ctx) =>
          runAuth(
            authCall(() =>
              ctx.context.adapter.findMany({
                model: "mcpGrant",
                where: [
                  { field: "revoked", value: false },
                  ...(ctx.body.after === null
                    ? []
                    : [{ field: "id", operator: "gt" as const, value: ctx.body.after }]),
                ],
                sortBy: { field: "id", direction: "asc" },
                limit: ctx.body.limit,
              }),
            ).pipe(
              Effect.flatMap((rows) => parse(Schema.Array(Record), rows)),
              Effect.map((rows) => ({
                grants: rows.map((row) => ({ id: row.id, userId: row.userId })),
              })),
            ),
          ),
      ),
      expireIdleMcpGrants: createAuthEndpoint(
        "/mcp/grants/expire-idle",
        {
          ...serverOnly,
          body: Schema.toStandardSchemaV1(
            Schema.Struct({
              ids: Schema.Array(GrantId).check(Schema.isMaxLength(grantBatch)),
              apply: Schema.Boolean,
            }),
          ),
        },
        (ctx) =>
          runAuth(
            expireIdle(ctx, ctx.body.ids, ctx.body.apply).pipe(
              Effect.map((grants) => ({ grants })),
            ),
          ),
      ),
      listMcpGrants: createAuthEndpoint(
        "/mcp/grants",
        { method: "GET", requireHeaders: true },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              // GET still requires same-origin browser authority, supplied by the dashboard client.
              const userId = yield* browser(ctx);
              const consents = yield* authCall(() =>
                ctx.context.adapter.findMany({
                  model: "oauthConsent",
                  where: [{ field: "userId", value: userId }],
                }),
              ).pipe(
                Effect.flatMap((rows) =>
                  parse(
                    Schema.Array(
                      Schema.Struct({
                        referenceId: Schema.NullOr(GrantId),
                        resources: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
                      }),
                    ),
                    rows,
                  ),
                ),
              );
              const targets = new Map<GrantId, GrantTarget>();
              for (const consent of consents) {
                if (consent.referenceId === null || consent.resources == null) continue;
                const target = grantTarget(resourceOrigins, consent.resources);
                if (target !== undefined) targets.set(consent.referenceId, target);
              }
              if (targets.size === 0) return [];
              const rows = yield* authCall(() =>
                ctx.context.adapter.findMany({
                  model: "mcpGrant",
                  where: [
                    { field: "userId", value: userId },
                    { field: "revoked", value: false },
                    { field: "id", operator: "in", value: [...targets.keys()] },
                  ],
                }),
              );
              const listed = yield* Effect.forEach(rows, (row) =>
                parse(Record, row).pipe(
                  Effect.flatMap((record) => {
                    const target = targets.get(record.id);
                    if (target === undefined) return Effect.fail(new APIError("UNAUTHORIZED"));
                    const current = project(ctx, record, target).pipe(Effect.map(Option.some));
                    // A grant whose connection was just revoked grants nothing; omit it.
                    return (record.connection ?? undefined) === undefined
                      ? current
                      : current.pipe(
                          Effect.catchIf(
                            (error) => error.statusCode === 401,
                            () => Effect.succeed(Option.none()),
                          ),
                        );
                  }),
                ),
              );
              return listed.flatMap((item) => (Option.isSome(item) ? [item.value] : []));
            }),
          ),
      ),
      narrowMcpGrant: createAuthEndpoint(
        "/mcp/grants/narrow",
        { method: "POST", requireHeaders: true },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const userId = yield* browser(ctx);
              const { id, policy } = yield* parse(
                Schema.Struct({ id: GrantId, policy: GrantPolicy }),
                ctx.body,
              );
              const row = yield* get(ctx, id);
              // A connection's grants follow the connection; edit the connection instead.
              if (row.userId !== userId || (row.connection ?? undefined) !== undefined)
                return yield* Effect.fail(new APIError("FORBIDDEN"));
              const target = yield* targetFor(ctx, row);
              const previous = (yield* project(ctx, row, target)).grant.policy;
              if (
                !isToolSelectionSubset(previous, policy) ||
                (previous.kind === "tools" &&
                  previous.approval === "browser" &&
                  policy.kind === "tools" &&
                  policy.approval !== "browser")
              )
                return yield* Effect.fail(new APIError("FORBIDDEN"));
              // Narrowing a full-access grant to browser approval at a model- or native-mode URL
              // would leave no URL that could use it.
              yield* requireServable(policy, target);
              yield* authCall(() =>
                ctx.context.adapter.update({
                  model: "mcpGrant",
                  where: [
                    { field: "id", value: id },
                    { field: "policy", value: row.policy },
                    { field: "revoked", value: false },
                  ],
                  update: { policy: JSON.stringify(policy) },
                }),
              ).pipe(
                Effect.flatMap((changed) =>
                  changed === null ? Effect.fail(new APIError("CONFLICT")) : Effect.void,
                ),
              );
              return { updated: true };
            }),
          ),
      ),
      revokeMcpGrant: createAuthEndpoint(
        "/mcp/grants/revoke",
        { method: "POST", requireHeaders: true },
        (ctx) =>
          runAuth(
            Effect.gen(function* () {
              const userId = yield* browser(ctx);
              const { id } = yield* parse(Schema.Struct({ id: GrantId }), ctx.body);
              const row = yield* get(ctx, id);
              if (row.userId !== userId) return yield* Effect.fail(new APIError("FORBIDDEN"));
              yield* revoke(ctx, id);
              return { revoked: true };
            }),
          ),
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(async (ctx) => {
            const input = Schema.decodeUnknownOption(Registration)(ctx.body);
            if (
              Option.isSome(input) &&
              input.value.application_type === undefined &&
              input.value.redirect_uris.length > 0 &&
              input.value.redirect_uris.every(loopback)
            )
              return { context: { body: { ...ctx.body, application_type: "native" } } };
          }),
        },
        {
          // Bind a request without `resource` before Better Auth signs and stores it, so consent,
          // the authorization code and its tokens all carry the same single audience.
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/authorize",
          handler: createAuthMiddleware(async (ctx) => {
            const post = ctx.method === "POST";
            const input = Schema.decodeUnknownOption(AuthorizeRequest)(post ? ctx.body : ctx.query);
            if (
              Option.isNone(input) ||
              input.value.resource !== undefined ||
              input.value.request_uri !== undefined
            )
              return;
            const resource = defaultResource(resourceOrigins.mcp[0], input.value.scope);
            if (resource === undefined)
              throw new APIError("BAD_REQUEST", {
                error: "invalid_target",
                error_description: "Name the Executor URL to authorize in the resource parameter.",
              });
            const named = { ...input.value, resource };
            return { context: post ? { body: named } : { query: named } };
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/consent",
          handler: createAuthMiddleware((ctx) =>
            runAuth(
              Effect.gen(function* () {
                const body = yield* parse(
                  Schema.Struct({ accept: Schema.Boolean, oauth_query: Schema.String }),
                  ctx.body,
                );
                if (!body.accept) return;
                const userId = yield* browser(ctx);
                const query = new URLSearchParams(body.oauth_query);
                const clientId = yield* parse(Schema.NonEmptyString, query.get("client_id"));
                const grant = yield* createGrant(ctx, userId, clientId, query.getAll("resource"));
                yield* authCall(() => selected.set({ userId, id: grant.id }));
              }),
            ),
          ),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/oauth2/delete-consent",
          handler: createAuthMiddleware((ctx) =>
            runAuth(
              Effect.gen(function* () {
                const userId = yield* browser(ctx);
                const { id } = yield* parse(Schema.Struct({ id: Schema.String }), ctx.body);
                const value = yield* authCall(() =>
                  ctx.context.adapter.findOne({
                    model: "oauthConsent",
                    where: [{ field: "id", value: id }],
                  }),
                );
                if (value === null) return;
                const consent = yield* parse(
                  Schema.Struct({ userId: Schema.String, referenceId: GrantId }),
                  value,
                );
                if (consent.userId !== userId) return yield* Effect.fail(new APIError("FORBIDDEN"));
                yield* revoke(ctx, consent.referenceId);
              }),
            ),
          ),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
  return {
    plugins: settings.deviceAuthorization
      ? ([oauthProvider(options), plugin, device] as const)
      : ([oauthProvider(options), plugin] as const),
    /** Insert missing resources once during host setup; never overwrite persisted policy. */
    provisionResources: (context: OAuthResourceSeedContext) =>
      Effect.tryPromise({
        try: () => seedOAuthResources(context, options),
        catch: () => new OAuthResourceProvisioningFailed(),
      }),
    /** The same insert-only seed a new connection gets, for a connection that already exists. */
    provisionConnectionResources: (context: OAuthResourceSeedContext, connection: ConnectionId) =>
      Effect.tryPromise({
        try: () => seedConnectionResources(context, connection),
        catch: () => new OAuthResourceProvisioningFailed(),
      }),
    authenticate: access,
    lookupBrowser,
  };
};

/** Grant storage could not be read or written; the next run tries again. */
export class GrantExpiryUnavailable extends Schema.TaggedError<GrantExpiryUnavailable>()(
  "GrantExpiryUnavailable",
  {},
) {}

/** The server-only endpoints that expire idle grants, as a host's own auth instance exposes them. */
export interface GrantExpiryApi {
  readonly listMcpGrantIds: (input: {
    body: { after: string | null; limit: number };
  }) => Promise<unknown>;
  readonly expireIdleMcpGrants: (input: {
    body: { ids: readonly string[]; apply: boolean };
  }) => Promise<unknown>;
}

/**
 * Grant expiry through a host's auth instance: list unrevoked grants in ID order, and check a
 * batch, revoking those idle for 30 days when applying. Results are parsed again at the boundary.
 */
export const grantExpiry = (
  call: <A>(run: (api: GrantExpiryApi) => Promise<A>) => Effect.Effect<A, unknown>,
) => ({
  batch: grantBatch,
  page: (after: string | null) =>
    call((api) => api.listMcpGrantIds({ body: { after, limit: grantBatch } })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GrantPage)),
      Effect.map((page) => page.grants),
      Effect.mapError(() => new GrantExpiryUnavailable()),
    ),
  expire: (ids: readonly string[], apply: boolean) =>
    call((api) => api.expireIdleMcpGrants({ body: { ids, apply } })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GrantExpiryResults)),
      Effect.map((result) => result.grants),
      Effect.mapError(() => new GrantExpiryUnavailable()),
    ),
});
export type GrantExpiry = ReturnType<typeof grantExpiry>;
