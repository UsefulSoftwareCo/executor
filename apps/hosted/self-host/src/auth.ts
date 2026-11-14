import {
  selfHostAuthOptions,
  selfHostAuthSettings,
  selfHostSsoDiscovery,
} from "./implementation/auth-options.ts";
import { selfHostRegistration, selfHostUserHooks } from "./implementation/registration.ts";
/** Better Auth over the host's shared, persisted PGlite database. */
import { betterAuth } from "better-auth";
import { HostedAppSessions, hostedAppSessions } from "@executor-js/hosted-server/app-ui";
import {
  McpAuthentication,
  mcpBrowserGrantError,
  mcpConnectionStore,
  provisionHostedOAuthResources,
  BearerAuthentication,
  apiBearerAccess,
  callerSpanAttributes,
  describeMcpAccess,
  mcpBearerAccess,
  SessionAuthentication,
  AuthenticationUnavailable,
  McpUnauthorized,
  sessionPrincipal,
  lookupMembership,
  lookupOrganizationSlug,
  resolveOrganizationReference,
  deleteOrganizationRecords,
  deleteUserRecords,
  grantExpiry,
  authEndpointTemplates,
} from "@executor-js/hosted-server";
import { routeTemplates } from "@executor-js/telemetry";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { AuthDatabase } from "./contracts/database.ts";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

const rateLimitBody = Schema.fromJsonString(
  Schema.Struct({
    message: Schema.String,
    error: Schema.optional(Schema.Unknown),
  }),
);
const oauthRateLimitPaths = new Set([
  "/api/auth/oauth2/register",
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/token",
]);

/** Initialize auth before listening; the database owns persistent users and sessions. */
export const selfHostAuth = Effect.gen(function* () {
  const settings = yield* selfHostAuthSettings;
  const database = yield* AuthDatabase;
  const sql = yield* SqlClient.SqlClient;
  const discovery = yield* selfHostSsoDiscovery(settings);
  const base = selfHostAuthOptions(settings, ["x-executor-client-ip"], discovery);
  const options = {
    ...base,
    plugins: [...base.plugins, selfHostRegistration(settings)],
    databaseHooks: selfHostUserHooks(settings),
    database,
    secret: Redacted.value(settings.secret),
  };
  const auth = betterAuth(options);
  const context = yield* Effect.tryPromise({
    try: () => auth.$context,
    catch: () => new AuthenticationUnavailable(),
  });
  const origins = {
    origin: settings.url,
    resourceOrigins: settings.resourceOrigins,
    issuer: settings.issuer,
  };
  yield* provisionHostedOAuthResources(origins, context).pipe(
    Effect.mapError(() => new AuthenticationUnavailable()),
  );
  const identity = Layer.succeed(SessionAuthentication, {
    ...origins,
    oauthRedirectUri: Option.getOrUndefined(settings.oauthRedirectUri),
    current: (headers) =>
      Effect.tryPromise({
        try: () =>
          auth.api.getSession({
            headers,
            query: { disableRefresh: true, disableCookieCache: true },
          }),
        catch: () => new AuthenticationUnavailable(),
      })
        .pipe(Effect.flatMap(sessionPrincipal))
        .pipe(Effect.withSpan("auth.current")),
    organization: (reference) => resolveOrganizationReference(context.adapter, reference),
    organizationSlug: (headers, organizationId) =>
      lookupOrganizationSlug(() =>
        auth.api.getOrganization({ headers, query: { organizationId } }),
      ).pipe(Effect.withSpan("auth.organizationSlug")),
    membership: (principal, organizationId) =>
      lookupMembership(context.adapter, principal, organizationId).pipe(
        Effect.withSpan("auth.membership"),
      ),
    removeOrganization: (organizationId) =>
      deleteOrganizationRecords(context.adapter, organizationId).pipe(
        Effect.withSpan("auth.removeOrganization"),
      ),
    removeUser: (user) =>
      deleteUserRecords(context.adapter, user).pipe(Effect.withSpan("auth.removeUser")),
  });
  const mcpIdentity = Layer.succeed(McpAuthentication, {
    ...origins,
    authenticate: (headers, mode, organization, connection) =>
      mcpBearerAccess(origins, { headers, mode, organization, connection }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.tap(({ access, userId }) =>
          Effect.annotateCurrentSpan(callerSpanAttributes(access.organization, userId)),
        ),
        Effect.withSpan("auth.authenticate"),
      ),
    sealGrant: (id) =>
      Effect.tryPromise({
        try: () => auth.api.sealMcpGrantRef({ body: { id } }),
        catch: () => new AuthenticationUnavailable(),
      }).pipe(Effect.map(({ ref }) => ref)),
    openGrant: (ref) =>
      Effect.tryPromise({
        try: () => auth.api.openMcpGrantRef({ body: { ref } }),
        catch: mcpBrowserGrantError,
      }).pipe(
        Effect.map(({ id }) => id),
        Effect.catchTag("McpApprovalForbidden", () => Effect.fail(new McpUnauthorized())),
      ),
    browserGrant: (headers, id) =>
      Effect.tryPromise({
        try: () => auth.api.getMcpBrowserAccess({ headers, body: { id } }),
        catch: mcpBrowserGrantError,
      }),
    describe: (access) =>
      describeMcpAccess(access).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    metadata: Effect.tryPromise({
      try: () => auth.api.getOAuthServerConfig(),
      catch: () => new AuthenticationUnavailable(),
    }),
    connections: mcpConnectionStore((run) =>
      Effect.tryPromise({ try: () => run(auth.api), catch: (cause) => cause }),
    ),
  });
  const apiIdentity = Layer.succeed(BearerAuthentication, {
    ...origins,
    authenticate: (headers, organization) =>
      apiBearerAccess(origins, { headers, organization }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.tap(({ access, userId }) =>
          Effect.annotateCurrentSpan(callerSpanAttributes(access.organization, userId)),
        ),
        Effect.withSpan("auth.authenticate"),
      ),
  });
  const routes = routeTemplates(authEndpointTemplates(auth.api));
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const incoming = yield* HttpServerRequest.toWeb(request);
    yield* routes.record(new URL(incoming.url).pathname);
    const web = new Request(incoming, { headers: new Headers(incoming.headers) });
    // The socket address is trusted. Never accept a client-supplied forwarding header.
    web.headers.delete("x-executor-client-ip");
    if (Option.isSome(request.remoteAddress))
      web.headers.set("x-executor-client-ip", request.remoteAddress.value);
    const response = yield* Effect.tryPromise({
      try: () => auth.handler(web),
      catch: () => new AuthenticationUnavailable(),
    });
    // Better Auth limits registration to five requests per minute. Its limiter
    // runs before the OAuth plugin and returns a generic message plus its own
    // cooldown header, which MCP clients cannot parse as an OAuth error.
    if (response.status === 429 && oauthRateLimitPaths.has(new URL(web.url).pathname)) {
      const parsed = yield* Effect.tryPromise({
        try: () => response.clone().text(),
        catch: () => new AuthenticationUnavailable(),
      }).pipe(Effect.map(Schema.decodeUnknownOption(rateLimitBody)));
      if (
        Option.isSome(parsed) &&
        parsed.value.error === undefined &&
        parsed.value.message === "Too many requests. Please try again later."
      ) {
        const headers = new Headers(response.headers);
        const cooldown = headers.get("retry-after") ?? headers.get("x-retry-after");
        if (cooldown !== null) headers.set("retry-after", cooldown);
        headers.delete("content-length");
        headers.set("content-type", "application/json");
        return HttpServerResponse.fromWeb(
          new Response(
            JSON.stringify({
              error: "temporarily_unavailable",
              error_description: parsed.value.message,
            }),
            { status: 429, headers },
          ),
        ).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
      }
    }
    return HttpServerResponse.fromWeb(response).pipe(
      HttpServerResponse.setHeader("cache-control", "no-store"),
    );
  }).pipe(
    Effect.catchTag("AuthenticationUnavailable", () =>
      Effect.succeed(HttpServerResponse.empty({ status: 503 })),
    ),
  );
  const appSessions = Layer.succeed(
    HostedAppSessions,
    hostedAppSessions(context, globalThis.crypto),
  );
  return {
    identity,
    mcpIdentity,
    apiIdentity,
    appSessions,
    agentGrants: grantExpiry((run) =>
      Effect.tryPromise({ try: () => run(auth.api), catch: (cause) => cause }),
    ),
    origin: settings.url,
    handler,
  };
});

/** The one auth instance, built before startup data steps and shared with the routes. */
export class SelfHostAuth extends Context.Service<
  SelfHostAuth,
  Effect.Success<typeof selfHostAuth>
>()("self-host/Auth") {}
