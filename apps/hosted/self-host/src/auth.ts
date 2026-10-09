import { selfHostAuthOptions, selfHostAuthSettings } from "./implementation/auth-options.ts";
import { selfHostRegistration, selfHostUserHooks } from "./implementation/registration.ts";
/** Better Auth over the host's shared, persisted PGlite database. */
import { betterAuth } from "better-auth";
import { HostedAppSessions, hostedAppSessions } from "@executor-js/hosted-server/app-ui";
import {
  McpAuthentication,
  mcpBrowserGrantError,
  mcpConnectionStore,
  provisionHostedOAuthResources,
  ApiAuthentication,
  apiBearerAccess,
  mcpBearerAccess,
  Authentication,
  AuthenticationUnavailable,
  sessionPrincipal,
  lookupMembership,
  lookupOrganizationSlug,
  resolveOrganizationReference,
  deleteOrganizationRecords,
  grantExpiry,
  authEndpointTemplates,
} from "@executor-js/hosted-server";
import { routeTemplates } from "@executor-js/telemetry";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { AuthDatabase } from "./contracts/database.ts";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

/** Initialize auth before listening; the database owns persistent users and sessions. */
export const selfHostAuth = Effect.gen(function* () {
  const settings = yield* selfHostAuthSettings;
  const database = yield* AuthDatabase;
  const sql = yield* SqlClient.SqlClient;
  const base = selfHostAuthOptions(settings, ["x-executor-client-ip"]);
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
  const identity = Layer.succeed(Authentication, {
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
  });
  const mcpIdentity = Layer.succeed(McpAuthentication, {
    ...origins,
    authenticate: (headers, mode, organization) =>
      mcpBearerAccess(origins, { headers, mode, organization }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.tap(({ access }) =>
          Effect.annotateCurrentSpan("executor.organization.id", access.organization),
        ),
        Effect.withSpan("auth.authenticate"),
      ),
    browserGrant: (headers, id) =>
      Effect.tryPromise({
        try: () => auth.api.getMcpBrowserAccess({ headers, body: { id } }),
        catch: mcpBrowserGrantError,
      }),
    metadata: Effect.tryPromise({
      try: () => auth.api.getOAuthServerConfig(),
      catch: () => new AuthenticationUnavailable(),
    }),
    connections: mcpConnectionStore((run) =>
      Effect.tryPromise({ try: () => run(auth.api), catch: (cause) => cause }),
    ),
  });
  const apiIdentity = Layer.succeed(ApiAuthentication, {
    ...origins,
    authenticate: (headers, organization) =>
      apiBearerAccess(origins, { headers, organization }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.tap(({ access }) =>
          Effect.annotateCurrentSpan("executor.organization.id", access.organization),
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
