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
import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  Grant,
  GrantId,
  GrantPolicy,
  GrantTarget,
  grantTarget,
  mcpResource,
  OAuthResourceProvisioningFailed,
} from "../contracts/grant.ts";

export type { OAuthResourceSeedContext } from "@better-auth/oauth-provider";

const Record = Schema.Struct({
  id: GrantId,
  userId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  policy: Schema.String,
  revoked: Schema.Boolean,
});
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
const selected = defineRequestState<{ userId: string; id: GrantId } | null>(() => null);
/** Preserve provider failures and translate storage outages without exposing tokens or SQL. */
export const authCall = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (isAPIError(error) ? error : new APIError("SERVICE_UNAVAILABLE")),
  });
/** Promise boundary for Better Auth plugin callbacks. */
export const runAuth = <A>(effect: Effect.Effect<A, APIError>) =>
  Effect.runPromiseExit(effect).then(
    Exit.match({
      onSuccess: (value) => value,
      onFailure: (cause) => {
        throw Cause.squash(cause);
      },
    }),
  );
const parse = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new APIError("BAD_REQUEST")),
  );
const loopback = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
};

/** Hosts select and authorize their own resource (an organization for hosted, an instance for local). */
export interface GrantOAuthOptions {
  readonly origin: string;
  readonly selectResource: (
    context: GenericEndpointContext,
    userId: string,
  ) => Effect.Effect<string, APIError>;
  readonly checkResource: (
    context: GenericEndpointContext,
    userId: string,
    resource: string,
  ) => Effect.Effect<void, APIError>;
  readonly resources: NonNullable<OAuthOptions<Scope[]>["resources"]>;
  readonly scopes: Scope[];
}
/** Missing grant records fail closed, including credentials issued before this plugin was installed. */
export const grantOAuthPlugins = (settings: GrantOAuthOptions) => {
  const { origin } = settings;
  const options = {
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
    accessTokenExpiresIn: 3600,
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
  } satisfies OAuthOptions<Scope[]>;
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
  const project = (row: typeof Record.Type, target: GrantTarget) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(GrantPolicy))(row.policy).pipe(
      Effect.mapError(() => new APIError("UNAUTHORIZED")),
      Effect.map((policy) =>
        GrantAccess.make({
          userId: row.userId,
          clientId: row.clientId,
          resource: row.resource,
          grant: { id: row.id, policy, target },
        }),
      ),
    );
  const browser = (context: GenericEndpointContext) =>
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
      return session.user.id;
    });
  const consentTarget = (value: unknown) =>
    parse(Schema.Struct({ resources: Schema.Array(Schema.String) }), value).pipe(
      Effect.flatMap(({ resources }) => {
        const target = grantTarget(origin, resources);
        return target === undefined
          ? Effect.fail(new APIError("UNAUTHORIZED"))
          : Effect.succeed(target);
      }),
      Effect.mapError(() => new APIError("UNAUTHORIZED")),
    );
  const targetFor = (context: GenericEndpointContext, row: typeof Record.Type) =>
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
      const target = yield* targetFor(context, row);
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      const audience = target.kind === "api" ? `${origin}/api` : mcpResource(origin, target.mode);
      if (
        audiences.length !== 1 ||
        audiences[0] !== audience ||
        target.kind !== kind ||
        !claims.scope.split(" ").includes(kind === "api" ? "executor" : "mcp")
      )
        return yield* Effect.fail(new APIError("UNAUTHORIZED"));
      yield* settings.checkResource(context, row.userId, row.resource);
      const value = yield* project(row, target);
      return value;
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
  const lookupBrowser = (ctx: GenericEndpointContext) =>
    Effect.gen(function* () {
      const userId = yield* browser(ctx);
      const { id } = yield* parse(Schema.Struct({ id: GrantId }), ctx.body);
      const row = yield* get(ctx, id);
      if (row.userId !== userId) return yield* Effect.fail(new APIError("FORBIDDEN"));
      yield* settings.checkResource(ctx, userId, row.resource);
      return yield* project(row, yield* targetFor(ctx, row));
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
                const target = grantTarget(origin, consent.resources);
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
              return yield* Effect.forEach(rows, (row) =>
                parse(Record, row).pipe(
                  Effect.flatMap((record) => {
                    const target = targets.get(record.id);
                    return target === undefined
                      ? Effect.fail(new APIError("UNAUTHORIZED"))
                      : project(record, target);
                  }),
                ),
              );
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
              if (row.userId !== userId) return yield* Effect.fail(new APIError("FORBIDDEN"));
              const previous = (yield* project(row, yield* targetFor(ctx, row))).grant.policy;
              if (
                !isToolSelectionSubset(previous, policy) ||
                (previous.kind === "tools" &&
                  previous.approval === "browser" &&
                  policy.kind === "tools" &&
                  policy.approval !== "browser")
              )
                return yield* Effect.fail(new APIError("FORBIDDEN"));
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
                const target = grantTarget(
                  origin,
                  new URLSearchParams(body.oauth_query).getAll("resource"),
                );
                if (target === undefined)
                  return yield* Effect.fail(
                    new APIError("BAD_REQUEST", {
                      message: "Choose one Executor connection URL and try again.",
                    }),
                  );
                const policyHeader = ctx.headers?.get("x-executor-grant");
                const policy =
                  policyHeader === null || policyHeader === undefined
                    ? GrantPolicy.make({ kind: "all" })
                    : yield* parse(Schema.fromJsonString(GrantPolicy), policyHeader);
                if (
                  target.kind === "mcp" &&
                  policy.kind === "tools" &&
                  policy.approval === "browser" &&
                  target.mode !== "browser"
                )
                  return yield* Effect.fail(new APIError("FORBIDDEN"));
                const resource = yield* settings.selectResource(ctx, userId);
                const clientId = yield* parse(
                  Schema.NonEmptyString,
                  new URLSearchParams(body.oauth_query).get("client_id"),
                );
                const row = yield* authCall(() =>
                  ctx.context.adapter.create({
                    model: "mcpGrant",
                    data: {
                      userId,
                      clientId,
                      resource,
                      policy: JSON.stringify(policy),
                      revoked: false,
                    },
                  }),
                );
                const grant = yield* parse(Record, row);
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
    plugins: [oauthProvider(options), plugin] as const,
    /** Insert missing resources once during host setup; never overwrite persisted policy. */
    provisionResources: (context: OAuthResourceSeedContext) =>
      Effect.tryPromise({
        try: () => seedOAuthResources(context, options),
        catch: () => new OAuthResourceProvisioningFailed(),
      }),
    authenticate: access,
    lookupBrowser,
  };
};
