import { apiKeys, apiKeyManagement } from "./api-keys.ts";
import { requestAuthentication } from "./batch-authentication.ts";
import { recordNoSession, recordSessionCredential, refuse } from "./auth-telemetry.ts";
import {
  CurrentUsage,
  isReadMethod,
  observeProductOperation,
  traceProductRead,
} from "../contracts/product-analytics.ts";
import { RequireOrganization } from "../contracts/organization.ts";
import { explicitOrganizationAuth } from "./organization-auth.ts";
import { mcpOAuthPlugins, type GrantObservers } from "./mcp-oauth.ts";
import type { ResourceOrigins } from "@executor-js/mcp-auth";
import type { BetterAuthOptions } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { Config, ErrorReporter, Effect, Layer, Schema } from "effect";
import { HttpUrl } from "@executor-js/sdk/core";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  SessionAuthentication,
  AuthenticationUnavailable,
  CurrentPrincipal,
  CurrentUserId,
  Forbidden,
  Principal,
  RequireBrowserSession,
  Unauthorized,
} from "../contracts/auth.ts";

export const accountOAuthRedirectUri = (
  auth: Pick<typeof SessionAuthentication.Service, "origin" | "oauthRedirectUri">,
) =>
  HttpUrl.make(
    new URL(auth.oauthRedirectUri ?? new URL("/api/oauth/callback", auth.origin).href).href,
  );

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

export const authOptions = (
  settings: Pick<Effect.Success<typeof authSettings>, "url" | "oauthRedirectUri"> & {
    readonly resourceOrigins: ResourceOrigins;
    readonly issuer: string;
  },
  ipAddressHeaders: string[],
  observers: GrantObservers = {},
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
        ...observers,
      }),
    ],
    hooks: { before: apiKeyManagement },
    session: { cookieCache: { enabled: false }, freshAge: 0 },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: { "/get-session": false, "/organization/list": false },
    },
    advanced: {
      cookiePrefix: "executor-hosted",
      ipAddress: { ipAddressHeaders },
      database: { joins: true },
    },
  }) satisfies BetterAuthOptions;

export const sessionPrincipal = (
  session: {
    readonly user: { readonly id: string; readonly name: string };
    readonly session: { readonly id: string; readonly impersonatedBy?: string | null | undefined };
  } | null,
) =>
  session === null
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(Principal)({
        userId: session.user.id,
        sessionId: session.session.id,
        name: session.user.name,
        ...(typeof session.session.impersonatedBy === "string"
          ? { impersonatedBy: session.session.impersonatedBy }
          : {}),
      }).pipe(Effect.mapError(() => new AuthenticationUnavailable()));

export const requireBrowserSessionLive = Layer.effect(
  RequireBrowserSession,
  Effect.gen(function* () {
    const auth = yield* SessionAuthentication;
    return (response, { endpoint, group }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.authorization !== undefined)
          return yield* refuse("bearer_not_allowed", new Unauthorized());
        if (
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          request.headers.origin !== auth.origin
        ) {
          return yield* refuse("origin_mismatch", new Forbidden());
        }
        const identity = yield* requestAuthentication(auth);
        const headers = new Headers(request.headers);
        const principal = yield* identity.current(headers);
        if (principal === null)
          return yield* Effect.andThen(recordNoSession(headers), Effect.fail(new Unauthorized()));
        yield* recordSessionCredential(principal);
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
