import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { genericOAuth } from "better-auth/plugins";
import { EmulatedServices } from "../contracts/emulators.ts";

/** Same Better Auth social endpoints, with verified OAuth/OIDC exchanges at external emulators. */
export const emulatedSocialProviders = (
  configuration: Redacted.Redacted<typeof EmulatedServices.Type>,
) => {
  const { google, github } = Redacted.value(configuration);
  return genericOAuth({
    config: [
      {
        providerId: "google",
        name: "Google",
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        discoveryUrl: `${google.baseUrl}/.well-known/openid-configuration`,
        scopes: ["openid", "email", "profile"],
        pkce: true,
        requireIdTokenVerification: true,
      },
      {
        providerId: "github",
        name: "GitHub",
        clientId: github.clientId,
        clientSecret: github.clientSecret,
        authorizationUrl: `${github.baseUrl}/login/oauth/authorize`,
        tokenUrl: `${github.baseUrl}/login/oauth/access_token`,
        scopes: ["user:email"],
        getUserInfo: (tokens) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                if (!tokens.accessToken) return null;
                const http = yield* HttpClient.HttpClient;
                const headers = {
                  authorization: `Bearer ${tokens.accessToken}`,
                  "user-agent": "Executor",
                };
                const profileResponse = yield* http.get(`${github.baseUrl}/user`, { headers });
                const emailResponse = yield* http.get(`${github.baseUrl}/user/emails`, { headers });
                if (profileResponse.status !== 200 || emailResponse.status !== 200) return null;
                const profile = yield* profileResponse.json.pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Struct({
                        id: Schema.Number,
                        login: Schema.String,
                        name: Schema.NullOr(Schema.String),
                        avatar_url: Schema.String,
                      }),
                    ),
                  ),
                );
                const emails = yield* emailResponse.json.pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Array(
                        Schema.Struct({
                          email: Schema.String,
                          primary: Schema.Boolean,
                          verified: Schema.Boolean,
                        }),
                      ),
                    ),
                  ),
                );
                const email = emails.find((entry) => entry.primary && entry.verified);
                if (!email) return null;
                return {
                  id: String(profile.id),
                  name: profile.name || profile.login,
                  email: email.email,
                  emailVerified: email.verified,
                  image: profile.avatar_url,
                };
              }),
            ).pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.catch(() => Effect.succeed(null)),
            ),
          ),
      },
    ],
  });
};
