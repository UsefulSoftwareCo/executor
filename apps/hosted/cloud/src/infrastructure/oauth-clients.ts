/** OAuth apps Executor registers itself, for services that offer no automatic registration. */
import type { HostOAuthClient } from "@executor-js/sdk/core";
import { Config, Effect, Option, Redacted } from "effect";
import { cloudEmulators } from "./emulators.ts";

const github = (origin: string, clientId: string, clientSecret: string): HostOAuthClient => ({
  authorizationEndpoint: `${origin}/login/oauth/authorize`,
  tokenEndpoint: `${origin}/login/oauth/access_token`,
  client: {
    client_id: clientId,
    client_secret: clientSecret,
    token_endpoint_auth_method: "client_secret_post",
  },
});

export const cloudOAuthClients = Effect.gen(function* () {
  const emulators = yield* cloudEmulators;
  if (Option.isSome(emulators)) {
    const { baseUrl, clientId, clientSecret } = Redacted.value(emulators.value).github;
    return [github(baseUrl, clientId, clientSecret)];
  }
  const clientId = yield* Config.option(Config.String("FIRST_PARTY_GITHUB_CLIENT_ID"));
  const clientSecret = yield* Config.option(Config.Redacted("FIRST_PARTY_GITHUB_CLIENT_SECRET"));
  if (Option.isSome(clientId) && Option.isSome(clientSecret))
    return [github("https://github.com", clientId.value, Redacted.value(clientSecret.value))];
  if (Option.isSome(clientId) || Option.isSome(clientSecret))
    return yield* Effect.die(
      new Error("Set FIRST_PARTY_GITHUB_CLIENT_ID and FIRST_PARTY_GITHUB_CLIENT_SECRET together"),
    );
  return [];
});
