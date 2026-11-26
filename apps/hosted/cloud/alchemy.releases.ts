import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Layer } from "effect";
import { stackState } from "./src/infrastructure/state.ts";

const releaseSecrets = [
  "NPM_TOKEN",
  "PUBLIC_RELEASE_APP_CLIENT_ID",
  "PUBLIC_RELEASE_APP_PRIVATE_KEY",
  "EXECUTOR_MAC_SIGNING_KEY",
  "EXECUTOR_MAC_SIGNING_CERTIFICATE",
  "EXECUTOR_MAC_NOTARY_KEY",
  "EXECUTOR_MAC_NOTARY_KEY_ID",
  "EXECUTOR_MAC_NOTARY_ISSUER",
] as const;

export default Alchemy.Stack(
  "executor-next-releases",
  {
    providers: Layer.mergeAll(GitHub.providers(), Cloudflare.providers()),
    state: stackState,
  },
  Effect.gen(function* () {
    const owner = "UsefulSoftwareCo";
    const repository = "executor-next";
    const name = "release";
    yield* Effect.forEach(releaseSecrets, (secret) =>
      Config.Redacted(secret).pipe(
        Effect.flatMap((value) =>
          GitHub.Secret(secret, { owner, repository, environment: name, name: secret, value }).pipe(
            retain(),
          ),
        ),
      ),
    );
    return { repository: `${owner}/${repository}`, environment: name, secrets: releaseSecrets };
  }),
);
