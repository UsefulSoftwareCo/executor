import { isToolSelectionSubset } from "@executor-js/authorization";
import type { AuthContext, BetterAuthPlugin, GenericEndpointContext } from "@better-auth/core";
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
import { deviceAuthorizationPlugin, devicePollsPerRequest } from "./device-authorization.ts";
import {
  ApprovalMode,
  ConnectionId,
  Grant,
  GrantId,
  GrantPolicy,
  GrantSettings,
  GrantTarget,
  defaultResource,
  grantScope,
  grantSettingsHeader,
  grantTarget,
  mcpOAuthResources,
  OAuthResourceProvisioningFailed,
  recordedTarget,
  type ResourceOrigins,
  legacyMcpTarget,
} from "../contracts/grant.ts";
import { approvalRefusal } from "../contracts/grant-enforcement.ts";
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
  mode: Schema.optionalKey(Schema.NullOr(ApprovalMode)),
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
const ConnectionOwner = { userId: Schema.NonEmptyString, resource: Schema.NonEmptyString };
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
const AuthorizeRequest = Schema.StructWithRest(
  Schema.Struct({
    scope: Schema.optionalKey(Schema.String),
    resource: Schema.optionalKey(Schema.Unknown),
    request_uri: Schema.optionalKey(Schema.Unknown),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const selected = defineRequestState<{ userId: string; id: GrantId } | null>(() => null);
interface AuthEndpoint {
  readonly path?: string;
  readonly options?: {
    readonly method?: unknown;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

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

const desktopLoopback = (value: string) => {
  const url = URL.parse(value);
  return url !== null && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
};

const redirectIdentity = (value: string) => {
  if (!loopback(value)) return value;
  const url = new URL(value);
  url.port = "";
  return url.href;
};

export type RefreshRejection = Parameters<
  NonNullable<OAuthOptions<Scope[]>["onRefreshRejected"]>
>[0];
export interface CreatedGrant {
  readonly userId: string;
  readonly clientId: string;
  readonly kind: GrantTarget["kind"];
  readonly organization: string;
}
const resolveBinding = (
  resolve: NonNullable<GrantOAuthOptions["resolveResource"]>,
  input: Parameters<NonNullable<GrantOAuthOptions["resolveResource"]>>[0],
) =>
  Effect.tryPromise({
    try: () => resolve(input),
    catch: (error) => (isAPIError(error) ? error : new APIError("SERVICE_UNAVAILABLE")),
  });

export interface ResourceBinding {
  readonly organization: string;
  readonly connection?: ConnectionId | undefined;
}
export interface GrantOAuthOptions {
  readonly origin: string;
  readonly resourceOrigins: ResourceOrigins;
  /**
   * The authorization server's issuer identifier, exact and without a trailing slash. It may
   * name another host than `origin` (RFC 8414): metadata, `iss` and introspection name it, while
   * every endpoint stays on `origin`. Hosts that serve one origin use `${origin}/api/auth`.
   */
  readonly issuer: string;
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
  readonly onRefreshRejected?: ((rejection: RefreshRejection) => void) | undefined;
  readonly onGrantCreated?: ((grant: CreatedGrant) => Promise<void>) | undefined;
  readonly resolveResource?:
    | ((input: {
        readonly userId: string;
        readonly resource: string;
        readonly organization: string | undefined;
      }) => Promise<ResourceBinding>)
    | undefined;
  /**
   * Offer RFC 8628 device authorization, approved on the browser origin's verification page.
   * Only hosts that serve that page and a signed-in browser session enable it.
   */
  readonly deviceAuthorization: boolean;
}
const accessTokenSeconds = 3600;
const refreshTokenSeconds = 30 * 24 * 3600;
const supersededRefreshSeconds = 24 * 3600;
export const GrantExpiryOutcome = Schema.Literals([
  "revoked",
  "idle",
  "live",
  "recent",
  "unconsented",
  "absent",
]);
export type GrantExpiryOutcome = typeof GrantExpiryOutcome.Type;
const GrantExpiryResults = Schema.Struct({
  grants: Schema.Array(Schema.Struct({ id: GrantId, outcome: GrantExpiryOutcome })),
});
export const GrantModeOutcome = Schema.Literals([
  "stored",
  "missing",
  "present",
  "api",
  "unreadable",
  "absent",
]);
export type GrantModeOutcome = typeof GrantModeOutcome.Type;
const GrantModeResults = Schema.Struct({
  grants: Schema.Array(Schema.Struct({ id: GrantId, outcome: GrantModeOutcome })),
});
const GrantPage = Schema.Struct({
  grants: Schema.Array(Schema.Struct({ id: GrantId, userId: Schema.NonEmptyString })),
});
const grantBatch = 200;
const grantSessionPrefix = "executor-grant-session:v1:";
const grantSessionBatch = 100;
const GrantSessionRecords = Schema.Array(Schema.Struct({ identifier: Schema.String }));
const GrantSessionRecord = Schema.Struct({ value: GrantId });
const BoundGrant = Schema.Struct({ resource: Schema.NonEmptyString, revoked: Schema.Boolean });

export const sessionGrantResource = (
  adapter: Pick<AuthContext["adapter"], "findOne">,
  session: string,
) =>
  Effect.gen(function* () {
    const bound = yield* authCall(() =>
      adapter.findOne({
        model: "verification",
        where: [{ field: "identifier", value: `${grantSessionPrefix}${session}` }],
      }),
    );
    if (bound === null) return Option.none<string>();
    const record = yield* Schema.decodeUnknownEffect(GrantSessionRecord)(bound).pipe(
      Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
    );
    const grant = yield* authCall(() =>
      adapter.findOne({ model: "mcpGrant", where: [{ field: "id", value: record.value }] }),
    );
    if (grant === null) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
    const row = yield* Schema.decodeUnknownEffect(BoundGrant)(grant).pipe(
      Effect.mapError(() => new APIError("SERVICE_UNAVAILABLE")),
    );
    if (row.revoked) return yield* Effect.fail(new APIError("UNAUTHORIZED"));
    return Option.some(row.resource);
  });
const SessionToken = Schema.Struct({ token: Schema.String });
const SlidSession = Schema.Struct({ id: Schema.String, expiresAt: Schema.Date });
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
    // RFC 7591 has no `application_type`, so MCP clients often omit it. A registration with an
    // RFC 8252 loopback or private-use callback is a native client, and every callback it names
    // is checked against the native rules; any other stays a web client. The OpenID default of
    // `web` refused such registrations, including Cursor's.
    clientRegistrationDefaultApplicationType: "infer",
    rateLimit: {
      register: { window: 60, max: 60 },
      token: {
        window: 60,
        max: 20 + (settings.deviceAuthorization ? devicePollsPerRequest : 0),
      },
    },
    grantTypes: ["authorization_code", "refresh_token"],
    disableJwtPlugin: true,
    accessTokenExpiresIn: accessTokenSeconds,
    refreshTokenExpiresIn: refreshTokenSeconds,
    refreshTokenReuseInterval: accessTokenSeconds,
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
    enforcePerClientResources: false,
  } satisfies OAuthOptions<Scope[]>;
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
  const currentPolicy = (context: GenericEndpointContext, row: typeof Record.Type) =>
    Effect.gen(function* () {
      const connection = row.connection ?? undefined;
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
    currentPolicy(context, row).pipe(
      Effect.map((policy) =>
        GrantAccess.make({
          userId: row.userId,
          clientId: row.clientId,
          resource: row.resource,
          grant: { id: row.id, policy, target },
        }),
      ),
    );
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
  const recordFor = (context: GenericEndpointContext, row: typeof Record.Type) =>
    consentFor(context, row).pipe(
      Effect.flatMap(({ target: consented, resource }) => {
        const target = recordedTarget(row, consented);
        return target === undefined
          ? Effect.fail(new APIError("UNAUTHORIZED"))
          : Effect.succeed({ consented, target, resource });
      }),
    );
  const targetFor = (context: GenericEndpointContext, row: typeof Record.Type) =>
    recordFor(context, row).pipe(Effect.map(({ target }) => target));
  const requireServable = (policy: GrantPolicy, target: GrantTarget) =>
    approvalRefusal(policy, target) === undefined
      ? Effect.void
      : Effect.fail(
          new APIError("FORBIDDEN", {
            message: "Browser approval needs a grant whose approval mode is browser.",
          }),
        );
  const access = (context: GenericEndpointContext, kind: GrantTarget["kind"]) =>
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
      const { consented, target, resource } = yield* recordFor(context, row);
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      if (
        audiences.length !== 1 ||
        audiences[0] !== resource ||
        consented.kind !== kind ||
        !claims.scope.split(" ").includes(grantScope(kind))
      )
        return yield* Effect.fail(new APIError("UNAUTHORIZED"));
      yield* settings.checkResource(context, row.userId, row.resource);
      return yield* project(context, row, target);
    });
  const grantSessions = (ctx: GenericEndpointContext, id: GrantId) =>
    authCall(() =>
      ctx.context.adapter.findMany({
        model: "verification",
        where: [
          { field: "identifier", operator: "starts_with", value: grantSessionPrefix },
          { field: "value", value: id },
        ],
        limit: grantSessionBatch,
      }),
    ).pipe(Effect.flatMap((rows) => parse(GrantSessionRecords, rows)));
  const endSessions = (ctx: GenericEndpointContext, id: GrantId): Effect.Effect<void, APIError> =>
    Effect.gen(function* () {
      const records = yield* grantSessions(ctx, id);
      if (records.length === 0) return;
      const sessions = yield* authCall(() =>
        ctx.context.adapter.findMany({
          model: "session",
          where: [
            {
              field: "id",
              operator: "in",
              value: records.map((record) => record.identifier.slice(grantSessionPrefix.length)),
            },
          ],
          limit: grantSessionBatch,
        }),
      ).pipe(Effect.flatMap((rows) => parse(Schema.Array(SessionToken), rows)));
      if (sessions.length > 0)
        yield* authCall(() =>
          ctx.context.internalAdapter.deleteSessions(sessions.map((session) => session.token)),
        );
      yield* authCall(() =>
        ctx.context.adapter.deleteMany({
          model: "verification",
          where: [
            {
              field: "identifier",
              operator: "in",
              value: records.map((record) => record.identifier),
            },
          ],
        }),
      );
      if (records.length === grantSessionBatch) yield* endSessions(ctx, id);
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
      yield* endSessions(ctx, id);
    });
  const bindSession = (
    ctx: GenericEndpointContext,
    id: GrantId,
    session: { readonly id: string; readonly expiresAt: Date },
  ) =>
    Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis);
      yield* authCall(() =>
        ctx.context.adapter.create({
          model: "verification",
          data: {
            identifier: `${grantSessionPrefix}${session.id}`,
            value: id,
            expiresAt: session.expiresAt,
            createdAt: now,
            updatedAt: now,
          },
        }),
      );
      yield* get(ctx, id).pipe(
        Effect.catchIf(
          (error) => error.status === "UNAUTHORIZED",
          () =>
            endSessions(ctx, id).pipe(Effect.andThen(Effect.fail(new APIError("UNAUTHORIZED")))),
        ),
      );
    });
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
  const usableGrants = (ctx: GenericEndpointContext, ids: readonly GrantId[]) =>
    Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis);
      const Live = Schema.Array(
        Schema.Struct({
          referenceId: GrantId,
          sessionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
          scopes: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
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
      const accessTokens = yield* live("oauthAccessToken");
      const refreshTokens = yield* live("oauthRefreshToken");
      const offline = refreshTokens.filter((token) => token.scopes?.includes("offline_access"));
      const tokens = [
        ...accessTokens,
        ...refreshTokens.filter((token) => !token.scopes?.includes("offline_access")),
      ];
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
      return new Set([
        ...offline.map((token) => token.referenceId),
        ...tokens.flatMap((token) =>
          token.sessionId == null || liveSessions.has(token.sessionId) ? [token.referenceId] : [],
        ),
      ]);
    });
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
            if (consent === undefined) return outcome.set(id, "unconsented");
            if (consent.createdAt >= since || consent.updatedAt >= since || (yield* touched(id)))
              return outcome.set(id, "recent");
            return outcome.set(id, "idle");
          }),
        { concurrency: 4, discard: true },
      );
      return outcome;
    });
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
  const storeModes = (ctx: GenericEndpointContext, ids: readonly GrantId[], apply: boolean) =>
    Effect.forEach(ids, (id) =>
      Effect.gen(function* () {
        const outcome = (value: GrantModeOutcome) => ({ id, outcome: value });
        const found = yield* authCall(() =>
          ctx.context.adapter.findOne({ model: "mcpGrant", where: [{ field: "id", value: id }] }),
        );
        if (found === null) return outcome("absent");
        const decoded = Schema.decodeUnknownOption(Record)(found);
        if (Option.isNone(decoded)) return outcome("unreadable");
        const row = decoded.value;
        if (row.revoked) return outcome("absent");
        if (row.mode != null) return outcome("present");
        const consent = yield* consentFor(ctx, row).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => error.statusCode !== 503,
            () => Effect.succeed(Option.none()),
          ),
        );
        if (Option.isNone(consent)) return outcome("unreadable");
        const target = recordedTarget(row, consent.value.target);
        if (target === undefined) return outcome("unreadable");
        if (target.kind !== "mcp") return outcome("api");
        if (!apply) return outcome("missing");
        const changed = yield* authCall(() =>
          ctx.context.adapter.update({
            model: "mcpGrant",
            where: [
              { field: "id", value: id },
              { field: "mode", operator: "eq", value: null },
            ],
            update: { mode: target.mode },
          }),
        );
        return outcome(changed === null ? "present" : "stored");
      }),
    );
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
                icon: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
      const clientOf = new Map(clients.map((client) => [client.clientId, client]));
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
            const consented =
              consent === undefined
                ? undefined
                : grantTarget(resourceOrigins, consent.resources ?? []);
            const target = consented === undefined ? undefined : recordedTarget(grant, consented);
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
              target.kind !== "mcp"
                ? { kind: target.kind }
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
                name: clientOf.get(grant.clientId)?.name ?? null,
                icon: clientOf.get(grant.clientId)?.icon ?? null,
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
  const requireNativeClient = (ctx: GenericEndpointContext, clientId: string) =>
    authCall(() =>
      ctx.context.adapter.findOne({
        model: "oauthClient",
        where: [{ field: "clientId", value: clientId }],
      }),
    ).pipe(
      Effect.flatMap((row) =>
        parse(Schema.Struct({ redirectUris: Schema.Array(Schema.String) }), row),
      ),
      Effect.flatMap(({ redirectUris }) =>
        redirectUris.length > 0 && redirectUris.every(desktopLoopback)
          ? Effect.void
          : Effect.fail(
              new APIError("BAD_REQUEST", {
                message:
                  "Only an app on this computer can sign in to the Executor desktop. Every redirect it registers must be http://127.0.0.1 or http://[::1].",
              }),
            ),
      ),
    );
  const lookupBrowser = (ctx: GenericEndpointContext) =>
    Effect.gen(function* () {
      const userId = yield* browser(ctx);
      const { id } = yield* parse(Schema.Struct({ id: GrantId }), ctx.body);
      const row = yield* get(ctx, id);
      if (row.userId !== userId) return yield* Effect.fail(new APIError("FORBIDDEN"));
      yield* settings.checkResource(ctx, userId, row.resource);
      return yield* project(ctx, row, yield* targetFor(ctx, row));
    });
  const createGrant = (
    ctx: GenericEndpointContext,
    userId: string,
    clientId: string,
    resources: readonly string[],
  ) =>
    Effect.gen(function* () {
      const named = grantTarget(resourceOrigins, resources);
      if (named === undefined)
        return yield* Effect.fail(
          new APIError("BAD_REQUEST", {
            message: "Choose one Executor connection URL and try again.",
          }),
        );
      const policyHeader = ctx.headers?.get("x-executor-grant") ?? undefined;
      const settingsHeader = ctx.headers?.get(grantSettingsHeader) ?? undefined;
      if (named.kind !== "mcp" && settingsHeader !== undefined)
        return yield* Effect.fail(new APIError("BAD_REQUEST"));
      if (named.kind === "desktop") yield* requireNativeClient(ctx, clientId);
      const chosen =
        settingsHeader === undefined
          ? {}
          : yield* parse(Schema.fromJsonString(GrantSettings), settingsHeader);
      const resource = resources[0];
      const legacy =
        resource === undefined ? undefined : legacyMcpTarget(resourceOrigins, resource)?.path;
      const bound =
        resource === undefined ||
        settings.resolveResource === undefined ||
        legacy === undefined ||
        (legacy.selector === undefined && legacy.toolkit === undefined)
          ? undefined
          : yield* resolveBinding(settings.resolveResource, {
              userId,
              resource,
              organization: ctx.headers?.get("x-executor-organization") ?? undefined,
            });
      if (
        bound?.connection !== undefined &&
        chosen.access !== undefined &&
        !(chosen.access.kind === "connection" && chosen.access.id === bound.connection)
      )
        return yield* Effect.fail(
          new APIError("BAD_REQUEST", { message: "This URL names its own toolkit." }),
        );
      const connectionId =
        named.kind !== "mcp"
          ? undefined
          : bound?.connection !== undefined
            ? bound.connection
            : chosen.access === undefined
              ? named.connection
              : chosen.access.kind === "connection"
                ? chosen.access.id
                : undefined;
      const connection =
        connectionId === undefined
          ? undefined
          : yield* ownedConnection(ctx, { userId }, connectionId).pipe(
              Effect.mapError(
                (error) =>
                  new APIError(error.statusCode === 503 ? "SERVICE_UNAVAILABLE" : "FORBIDDEN", {
                    message: "This connection is no longer available.",
                  }),
              ),
            );
      if (connection !== undefined && policyHeader !== undefined)
        return yield* Effect.fail(new APIError("BAD_REQUEST"));
      const target: GrantTarget =
        named.kind !== "mcp"
          ? named
          : connection === undefined
            ? { kind: "mcp", mode: chosen.mode ?? named.mode }
            : { kind: "mcp", mode: chosen.mode ?? named.mode, connection: connection.id };
      const policy =
        connection !== undefined
          ? connectionGrantPlaceholder
          : policyHeader === undefined
            ? GrantPolicy.make({ kind: "all" })
            : yield* parse(Schema.fromJsonString(GrantPolicy), policyHeader);
      yield* requireServable(policy, target);
      const organization = yield* settings.selectResource(
        ctx,
        userId,
        connection?.resource ?? bound?.organization,
      );
      const row = yield* authCall(() =>
        ctx.context.adapter.create({
          model: "mcpGrant",
          data: {
            userId,
            clientId,
            resource: organization,
            policy: JSON.stringify(policy),
            revoked: false,
            ...(target.kind === "mcp" ? { mode: target.mode } : {}),
            ...(connection === undefined ? {} : { connection: connection.id }),
          },
        }),
      );
      const grant = yield* parse(Record, row);
      const observe = settings.onGrantCreated;
      if (observe !== undefined)
        yield* Effect.tryPromise(() =>
          observe({ userId, clientId, kind: target.kind, organization }),
        ).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Agent grant was not observed", cause)),
        );
      yield* retireReplaced(ctx, grant, resources).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Replaced agent grants were not revoked", cause),
        ),
      );
      return grant;
    });
  const device = deviceAuthorizationPlugin({
    origin,
    provider: options,
    accepts: (resource) => {
      const target = grantTarget(resourceOrigins, [resource]);
      return target !== undefined && target.kind !== "desktop";
    },
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
    init: (context: AuthContext) => ({
      options: {
        databaseHooks: {
          session: {
            update: {
              after: (row: unknown) =>
                runAuth(
                  Effect.gen(function* () {
                    const session = Schema.decodeUnknownOption(SlidSession)(row);
                    if (Option.isNone(session)) return;
                    yield* authCall(() =>
                      context.adapter.updateMany({
                        model: "verification",
                        where: [
                          {
                            field: "identifier",
                            value: `${grantSessionPrefix}${session.value.id}`,
                          },
                        ],
                        update: { expiresAt: session.value.expiresAt },
                      }),
                    );
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logError(
                        "A session a grant signed in kept its old expiry; revoking the grant may leave it signed in after that expiry",
                        cause,
                      ),
                    ),
                  ),
                ),
            },
          },
        },
      },
    }),
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
          connection: { type: "string", required: false },
          mode: { type: "string", required: false },
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
              if (existing !== undefined)
                return existing.userId === input.userId &&
                  existing.resource === input.resource &&
                  !existing.revoked
                  ? yield* connectionView(existing)
                  : yield* Effect.fail(new APIError("CONFLICT"));
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
              return { revoked: true, id: row.id };
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
              return { revoked: true, id: row.id };
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
      storeMcpGrantModes: createAuthEndpoint(
        "/mcp/grants/store-modes",
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
            storeModes(ctx, ctx.body.ids, ctx.body.apply).pipe(
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
                    const consented = targets.get(record.id);
                    if (consented === undefined) return Effect.fail(new APIError("UNAUTHORIZED"));
                    const target = recordedTarget(record, consented);
                    if (target === undefined) return Effect.succeed(Option.none());
                    const current = project(ctx, record, target).pipe(Effect.map(Option.some));
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
    provisionResources: (context: OAuthResourceSeedContext) =>
      Effect.tryPromise({
        try: () => seedOAuthResources(context, options),
        catch: () => new OAuthResourceProvisioningFailed(),
      }),
    provisionConnectionResources: (context: OAuthResourceSeedContext, connection: ConnectionId) =>
      Effect.tryPromise({
        try: () => seedConnectionResources(context, connection),
        catch: () => new OAuthResourceProvisioningFailed(),
      }),
    authenticate: access,
    bindSession,
    lookupBrowser,
  };
};

export class GrantExpiryUnavailable extends Schema.TaggedError<GrantExpiryUnavailable>()(
  "GrantExpiryUnavailable",
  {},
) {}

export interface GrantExpiryApi {
  readonly listMcpGrantIds: (input: {
    body: { after: string | null; limit: number };
  }) => Promise<unknown>;
  readonly expireIdleMcpGrants: (input: {
    body: { ids: readonly string[]; apply: boolean };
  }) => Promise<unknown>;
  readonly storeMcpGrantModes: (input: {
    body: { ids: readonly string[]; apply: boolean };
  }) => Promise<unknown>;
}

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
  storeModes: (ids: readonly string[], apply: boolean) =>
    call((api) => api.storeMcpGrantModes({ body: { ids, apply } })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GrantModeResults)),
      Effect.map((result) => result.grants),
      Effect.mapError(() => new GrantExpiryUnavailable()),
    ),
});
export type GrantExpiry = ReturnType<typeof grantExpiry>;
