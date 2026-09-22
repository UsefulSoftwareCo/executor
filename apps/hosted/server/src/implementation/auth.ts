import { apiKeys, apiKeyManagement } from "./api-keys.ts";
import { explicitOrganizationAuth } from "./organization-auth.ts";
import { mcpOAuthPlugins } from "./mcp-oauth.ts";
import type { BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { admin } from "better-auth/plugins/admin";
import { Config, Effect, Layer, Schema } from "effect";
import { HttpUrl } from "@executor-js/sdk/core";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  Authentication,
  AuthenticationUnavailable,
  CurrentPrincipal,
  Forbidden,
  Principal,
  RequireUser,
  Unauthorized,
} from "../contracts/auth.ts";

/** Connected-account OAuth uses the configured relay URL, or this host's callback. */
export const accountOAuthRedirectUri = (
  auth: Pick<typeof Authentication.Service, "origin" | "oauthRedirectUri">,
) => HttpUrl.make(auth.oauthRedirectUri ?? new URL("/api/oauth/callback", auth.origin).href);

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

/** Shared session and protocol defaults; each host supplies its sign-in policy. */
export const authOptions = (
  settings: Pick<Effect.Success<typeof authSettings>, "url" | "oauthRedirectUri">,
  ipAddressHeaders: string[],
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
      organization({ disableOrganizationDeletion: true }),
      ...mcpOAuthPlugins(settings.url),
    ],
    hooks: { before: apiKeyManagement },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database" },
    advanced: { cookiePrefix: "executor-hosted", ipAddress: { ipAddressHeaders } },
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
    return (response) =>
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
        return (yield* response.pipe(Effect.provideService(CurrentPrincipal, principal))).pipe(
          HttpServerResponse.setHeader("cache-control", "no-store"),
        );
      });
  }),
);
