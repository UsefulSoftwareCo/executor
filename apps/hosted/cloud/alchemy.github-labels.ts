/** Repository labels have a separate lifecycle from CI credentials and deployment settings. */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Layer } from "effect";
import { stackState } from "./src/infrastructure/state.ts";

export default Alchemy.Stack(
  "executor-next-github-labels",
  {
    providers: Layer.mergeAll(GitHub.providers(), Cloudflare.providers()),
    state: stackState,
  },
  Effect.gen(function* () {
    const owner = yield* Config.NonEmptyString("GITHUB_OWNER");
    const repository = yield* Config.NonEmptyString("GITHUB_REPOSITORY_NAME");
    const deferred = yield* GitHub.Label("DeferredLabel", {
      owner,
      repository,
      name: "deferred",
      color: "d4c5f9",
      description: "Parked for later; not in the current merge queue.",
    }).pipe(retain());

    return { repository: `${owner}/${repository}`, deferred: deferred.name };
  }),
);
