import { selfHostAuthOptions, selfHostAuthSettings } from "./implementation/auth-options.ts";
import { selfHostRegistration, selfHostUserHooks } from "./implementation/registration.ts";
/** Better Auth over the host's shared, persisted PGlite database. */
import { betterAuth } from "better-auth";
import { HostedAppSessions, hostedAppSessions } from "@executor-js/hosted-server/app-ui";
import {
  McpAuthentication,
  mcpAuthenticationError,
  provisionHostedOAuthResources,
  ApiAuthentication,
  apiAuthenticationError,
  Authentication,
  AuthenticationUnavailable,
  sessionPrincipal,
  lookupMembership,
  lookupOrganizationSlug,
  resolveOrganizationReference,
  deleteOrganizationRecords,
} from "@executor-js/hosted-server";
import { Effect, Layer, Option, Redacted } from "effect";
import { AuthDatabase } from "./contracts/database.ts";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/** Initialize auth before listening; the database owns persistent users and sessions. */
export const selfHostAuth = Effect.gen(function* () {
  const settings = yield* selfHostAuthSettings;
  const database = yield* AuthDatabase;
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
  yield* provisionHostedOAuthResources(settings.url, context).pipe(
    Effect.mapError(() => new AuthenticationUnavailable()),
  );
  const identity = Layer.succeed(Authentication, {
    origin: settings.url,
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
    membership: (headers, organizationId) =>
      lookupMembership(() =>
        auth.api.getActiveMemberRole({ headers, query: { organizationId }, returnHeaders: true }),
      ).pipe(Effect.withSpan("auth.membership")),
    removeOrganization: (organizationId) =>
      deleteOrganizationRecords(context.adapter, organizationId).pipe(
        Effect.withSpan("auth.removeOrganization"),
      ),
  });
  const mcpIdentity = Layer.succeed(McpAuthentication, {
    origin: settings.url,
    authenticate: (headers, mode) =>
      Effect.tryPromise({
        try: () => auth.api.getMcpAccess({ headers, query: { mode } }),
        catch: mcpAuthenticationError,
      }).pipe(Effect.withSpan("auth.authenticate")),
    browserGrant: (headers, id) =>
      Effect.tryPromise({
        try: () => auth.api.getMcpBrowserAccess({ headers, body: { id } }),
        catch: mcpAuthenticationError,
      }),
    metadata: Effect.tryPromise({
      try: () => auth.api.getOAuthServerConfig(),
      catch: () => new AuthenticationUnavailable(),
    }),
  });
  const apiIdentity = Layer.succeed(ApiAuthentication, {
    origin: settings.url,
    authenticate: (headers, organization) =>
      Effect.tryPromise({
        try: () => auth.api.getApiAccess({ headers, query: { organization } }),
        catch: apiAuthenticationError,
      }).pipe(Effect.withSpan("auth.authenticate")),
  });
  const handler = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const web = yield* HttpServerRequest.toWeb(request);
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
    origin: settings.url,
    handler,
  };
});
