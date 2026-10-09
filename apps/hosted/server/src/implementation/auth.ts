import { apiKeys, apiKeyManagement } from "./api-keys.ts";
import {
  CurrentUsage,
  isReadMethod,
  observeProductOperation,
  traceProductRead,
} from "../contracts/product-analytics.ts";
import { RequireOrganization } from "../contracts/organization.ts";
import { explicitOrganizationAuth } from "./organization-auth.ts";
import { mcpOAuthPlugins } from "./mcp-oauth.ts";
import type { ResourceOrigins } from "@executor-js/mcp-auth";
import type { BetterAuthOptions } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { Config, ErrorReporter, Effect, Layer, Schema } from "effect";
import { HttpUrl } from "@executor-js/sdk/core";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  Authentication,
  AuthenticationUnavailable,
  CurrentPrincipal,
  CurrentUserId,
  Forbidden,
  Principal,
  RequireUser,
  Unauthorized,
} from "../contracts/auth.ts";

/**
 * Connected-account OAuth uses the configured relay URL, or this host's callback. It is returned
 * serialized, the form the SDK parses it to and sends as `redirect_uri`, so setup screens and the
 * client metadata document list that exact string, whatever form the operator configured.
 */
export const accountOAuthRedirectUri = (
  auth: Pick<typeof Authentication.Service, "origin" | "oauthRedirectUri">,
) =>
  HttpUrl.make(
    new URL(auth.oauthRedirectUri ?? new URL("/api/oauth/callback", auth.origin).href).href,
  );

/** Explicit host configuration. Missing or weak signing secrets fail startup/deploy. */
export const authSettings = Config.all({
  url: Config.String("BETTER_AUTH_URL"),
  secret: Config.Redacted("BETTER_AUTH_SECRET"),
  oauthRedirectUri: Config.String("EXECUTOR_OAUTH_CALLBACK_URL").pipe(Config.option),
}).pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Struct({
        url: Schema.String.check(
          Schema.makeFilter(
            (value) => {
              try {
                const url = new URL(value);
                return (
                  (url.protocol === "http:" || url.protocol === "https:") && url.origin === value
                );
              } catch {
                return false;
              }
            },
            { message: "BETTER_AUTH_URL must be an HTTP(S) origin without a trailing slash" },
          ),
        ),
        secret: Schema.Redacted(Schema.String.check(Schema.isMinLength(32))),
        oauthRedirectUri: Schema.Option(HttpUrl),
      }),
    ),
  ),
);

/**
 * Shared session and protocol defaults; each host supplies its sign-in policy and its
 * organization plugin, so no host builds an organization plugin it then discards.
 */
export const authOptions = (
  settings: Pick<Effect.Success<typeof authSettings>, "url" | "oauthRedirectUri"> & {
    /** The origins of MCP and API OAuth resources; `url` stays the browser origin. */
    readonly resourceOrigins: ResourceOrigins;
    /** The authorization server's issuer; `${url}/api/auth` where one origin serves everything. */
    readonly issuer: string;
  },
  ipAddressHeaders: string[],
  onRefreshFamilyRevoked?: () => void,
) =>
  ({
    appName: "Executor",
    baseURL: settings.url,
    basePath: "/api/auth",
    trustedOrigins: [settings.url],
    emailAndPassword: { enabled: false },
    account: { encryptOAuthTokens: true },
    onAPIError: { errorURL: `${settings.url}/login` },
    plugins: [
      admin(),
      explicitOrganizationAuth,
      apiKeys,
      ...mcpOAuthPlugins({
        origin: settings.url,
        resourceOrigins: settings.resourceOrigins,
        issuer: settings.issuer,
        onRefreshFamilyRevoked,
      }),
    ],
    hooks: { before: apiKeyManagement },
    // Session age gates nothing: the account Security page lists sessions however long ago this
    // browser signed in. Account deletion is disabled; enabling it needs its own confirmation.
    session: { cookieCache: { enabled: false }, freshAge: 0 },
    rateLimit: {
      enabled: true,
      storage: "database",
      // Every dashboard page reads the session, and organization pages the membership list, on
      // the server with the visitor's address. These reads require a valid session cookie and
      // change nothing; a per-address limit on them would make whole pages unavailable to people
      // sharing an address. Sign-in, sign-up and other credential routes keep their limits.
      customRules: { "/get-session": false, "/organization/list": false },
    },
    advanced: {
      cookiePrefix: "executor-hosted",
      ipAddress: { ipAddressHeaders },
      // Read a session and its user in one statement instead of one query each.
      database: { joins: true },
    },
  }) satisfies BetterAuthOptions;

/** Project only identity fields; never expose Better Auth tokens as product identity. */
export const sessionPrincipal = (
  session: {
    readonly user: { readonly id: string; readonly name: string };
    readonly session: { readonly id: string };
  } | null,
) =>
  session === null
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(Principal)({
        userId: session.user.id,
        sessionId: session.session.id,
        name: session.user.name,
      }).pipe(Effect.mapError(() => new AuthenticationUnavailable()));

/** Authenticate each request and reject foreign-origin cookie writes. */
export const requireUserLive = Layer.effect(
  RequireUser,
  Effect.gen(function* () {
    const auth = yield* Authentication;
    return (response, { endpoint, group }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // Browser-only endpoints never fall back from a presented grant to a cookie.
        if (request.headers.authorization !== undefined) return yield* new Unauthorized();
        if (
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          request.headers.origin !== auth.origin
        ) {
          return yield* Effect.fail(new Forbidden());
        }
        const principal = yield* auth.current(new Headers(request.headers));
        if (principal === null) return yield* Effect.fail(new Unauthorized());
        const operation = {
          area: group.identifier,
          operation: endpoint.identifier,
          method: endpoint.method,
        };
        const tracked = endpoint.middlewares.has(RequireOrganization)
          ? response
          : isReadMethod(endpoint.method)
            ? traceProductRead(operation, response)
            : observeProductOperation(operation, response, (result) => ({
                status_code: result.status,
                ok: result.status < 400,
                outcome: result.status < 400 ? "success" : "failure",
              }));
        return (yield* tracked.pipe(
          Effect.tapCause(ErrorReporter.report),
          Effect.provideService(CurrentPrincipal, principal),
          Effect.provideService(CurrentUserId, principal.userId),
          Effect.provideService(CurrentUsage, { source: "dashboard" }),
        )).pipe(HttpServerResponse.setHeader("cache-control", "no-store"));
      });
  }),
);
