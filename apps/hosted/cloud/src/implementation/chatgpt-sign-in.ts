/** Optional ChatGPT identity provider; credentials stay in the API Worker. */
import type { BetterAuthPlugin } from "better-auth";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { validateAuthorizationCode } from "@better-auth/core/oauth2";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { HttpUrl } from "@executor-js/sdk/core";

const RedirectUri = HttpUrl.check(
  Schema.makeFilter(
    (value) => {
      const url = new URL(value);
      return url.pathname === "/api/auth/callback/openai" && url.search === "" && url.hash === "";
    },
    {
      message:
        "CHATGPT_REDIRECT_URI must name /api/auth/callback/openai without a query or fragment",
    },
  ),
);

const Settings = Schema.Struct({
  clientId: Schema.NonEmptyString,
  clientSecret: Schema.Redacted(Schema.NonEmptyString),
  redirectUri: Schema.Option(RedirectUri),
});

/** An absent client disables ChatGPT; incomplete credentials fail configuration. */
export const chatGptSettings = Effect.gen(function* () {
  const clientId = yield* Config.String("CHATGPT_CLIENT_ID").pipe(Config.option);
  const clientSecret = yield* Config.Redacted("CHATGPT_CLIENT_SECRET").pipe(Config.option);
  const redirectUri = yield* Config.String("CHATGPT_REDIRECT_URI").pipe(Config.option);
  if (Option.isNone(clientId) && Option.isNone(clientSecret) && Option.isNone(redirectUri))
    return Option.none();
  if (Option.isNone(clientId) || Option.isNone(clientSecret))
    return yield* Effect.die(new Error("Set CHATGPT_CLIENT_ID and CHATGPT_CLIENT_SECRET together"));
  return Option.some(
    yield* Schema.decodeUnknownEffect(Settings)({
      clientId: clientId.value,
      clientSecret: clientSecret.value,
      redirectUri,
    }),
  );
});

const Identity = Schema.Struct({
  sub: Schema.NonEmptyString,
  iss: Schema.Literal("https://auth.openai.com"),
  exp: Schema.Number,
  iat: Schema.Number,
  email: Schema.NonEmptyString,
  email_verified: Schema.Literal(true),
  name: Schema.optional(Schema.String),
});

/** The stable social callback returns through the edge to the browser's state cookie. */
export const chatGptSignIn = (settings: typeof Settings.Type, callbackOrigin: string) => {
  // Existing clients can retain their registered deployment callback through a host move.
  // Both the deployment and edge callbacks route to the browser origin holding the state cookie.
  const redirectURI = Option.getOrElse(
    settings.redirectUri,
    () => `${callbackOrigin}/api/auth/callback/openai`,
  );
  return {
    ...genericOAuth({
      config: [
        {
          providerId: "openai",
          name: "ChatGPT",
          clientId: settings.clientId,
          clientSecret: Redacted.value(settings.clientSecret),
          discoveryUrl: "https://auth.openai.com/.well-known/openid-configuration",
          redirectURI,
          scopes: ["openid", "profile", "email"],
          pkce: true,
          requireIdTokenVerification: true,
          tokenEndpointAuth: { method: "client_secret_basic" },
          disableProviderLogout: true,
          getToken: async (transaction) => {
            try {
              const tokens = await validateAuthorizationCode({
                ...transaction,
                options: {
                  clientId: settings.clientId,
                  clientSecret: Redacted.value(settings.clientSecret),
                  redirectURI,
                },
                tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
                tokenEndpointAuth: { method: "client_secret_basic" },
              });
              Schema.decodeUnknownSync(Schema.NonEmptyString)(tokens.idToken);
              return tokens;
            } catch {
              throw new APIError("UNAUTHORIZED", {
                message: "ChatGPT could not verify this sign-in. Try again.",
              });
            }
          },
          mapProfileToUser: (profile) => {
            const parsed = Schema.decodeUnknownOption(Identity)(profile);
            if (Option.isNone(parsed))
              throw new APIError("UNAUTHORIZED", {
                message: "ChatGPT did not provide a verified email and valid identity claims.",
              });
            const identity = parsed.value;
            return {
              email: identity.email,
              emailVerified: true,
              name: identity.name ?? identity.email,
            };
          },
          accountSubject: ({ profile }) => {
            const subject = Schema.decodeUnknownSync(Schema.NonEmptyString)(profile.sub);
            return JSON.stringify(["https://auth.openai.com", settings.clientId, subject]);
          },
        },
      ],
    }),
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === "/sign-in/social" &&
            context.body?.provider === "openai" &&
            context.body?.idToken !== undefined,
          handler: createAuthMiddleware(async () => {
            throw new APIError("UNAUTHORIZED", {
              message: "Start ChatGPT sign-in from the sign-in page.",
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
