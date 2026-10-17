/** The SSO user's profile, with `email_verified` read from the userinfo endpoint when the ID token omits it. */
import type { OAuth2Tokens } from "@better-auth/core/oauth2";
import type { GenericOAuthUserInfo } from "better-auth/plugins/generic-oauth";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

const Claims = Schema.Struct({
  sub: Schema.String,
  email: Schema.optionalKey(Schema.String),
  email_verified: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(Schema.String),
  picture: Schema.optionalKey(Schema.String),
});
const Discovery = Schema.Struct({ userinfo_endpoint: Schema.optionalKey(Schema.String) });

const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value);

/** The claims of an ID token the provider has already verified against the issuer's keys. */
const idTokenClaims = (idToken: string) =>
  Effect.try(() => {
    const [, payload = ""] = idToken.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as unknown;
  }).pipe(Effect.flatMap((payload) => decode(Claims, payload)));

const profile = (claims: typeof Claims.Type): GenericOAuthUserInfo => ({
  ...claims,
  id: claims.sub,
  emailVerified: claims.email_verified ?? false,
  image: claims.picture,
});

/**
 * Better Auth takes the profile from the ID token whenever it names a subject and an email, and
 * never asks the userinfo endpoint for the rest. Some issuers put `email_verified` only there: an
 * Okta tenant-root issuer, for one, so every sign-in through it arrived unverified and was
 * refused. This reads the claim from userinfo when the ID token leaves it out, for the subject the
 * token named (OpenID Connect Core 1.0, 5.3.2), and otherwise keeps the token's profile. A user
 * the provider cannot vouch for stays unverified; nothing here grants what the issuer did not.
 */
export const ssoUserInfo = (discoveryUrl: string) => {
  let userinfoEndpoint: Promise<string | undefined> | undefined;
  const endpoint = Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(discoveryUrl, { headers: { accept: "application/json" } });
    if (response.status !== 200) return undefined;
    const document = yield* response.json.pipe(Effect.flatMap((body) => decode(Discovery, body)));
    const found = document.userinfo_endpoint;
    return found !== undefined && new URL(found).protocol === "https:" ? found : undefined;
  });
  return (tokens: OAuth2Tokens): Promise<GenericOAuthUserInfo | null> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          if (tokens.idToken === undefined) return null;
          const claims = yield* idTokenClaims(tokens.idToken);
          if (claims.email_verified !== undefined || tokens.accessToken === undefined)
            return profile(claims);
          // One discovery read per process; the plugin read the same document at startup.
          userinfoEndpoint ??= Effect.runPromise(
            endpoint.pipe(
              Effect.scoped,
              Effect.provide(FetchHttpClient.layer),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
          );
          const userinfo = yield* Effect.promise(
            () => userinfoEndpoint ?? Promise.resolve(undefined),
          );
          if (userinfo === undefined) return profile(claims);
          const http = yield* HttpClient.HttpClient;
          const response = yield* http.get(userinfo, {
            headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" },
          });
          if (response.status !== 200) return profile(claims);
          const asserted = yield* response.json.pipe(
            Effect.flatMap((body) => decode(Claims, body)),
          );
          // A userinfo response about another subject is not this user's (OpenID Connect Core 5.3.2).
          if (asserted.sub !== claims.sub) return null;
          const email = claims.email ?? asserted.email;
          return profile({
            ...asserted,
            ...claims,
            ...(email === undefined ? {} : { email }),
            // The endpoint vouches for the address it returned, which must be the one signing in.
            email_verified:
              email !== undefined && asserted.email === email && asserted.email_verified === true,
          });
        }),
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.catch(() => Effect.succeed(null)),
      ),
    );
};
