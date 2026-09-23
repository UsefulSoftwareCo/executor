/** Release credentials have their own lifecycle, separate from production and repository policy. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Layer } from "effect";
import { stackState } from "./src/infrastructure/state.ts";

const releaseSecrets = [
  "NPM_TOKEN",
  "PUBLIC_RELEASE_TOKEN",
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
    // The release environment already exists. Managing its secrets requires only
    // Environments write; creating or changing its policy requires broader access.
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
