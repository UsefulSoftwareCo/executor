/**
 * Production deploy events (`src/infrastructure/deploy-events.ts`; `notes/ci.md`, "Deploy
 * events"): the Axiom dataset the recorder (`.github/workflows/deploy-events.yml`) records each
 * Deploy attempt in, an ingest-only token for it, and the repository secret and variable the
 * recorder reads them from.
 *
 * It owns nothing else. The CI stack (`alchemy.github.ts`) keeps every other secret, variable,
 * environment and repository setting, and this stack has its own state, so applying it cannot change
 * them. The secret and variable are repository-scoped, not in `production`: on this repository's
 * plan an environment cannot be limited to `main`, so a dedicated one would restrict nothing more,
 * and the recorder needs none of production's credentials (`notes/ci.md`).
 *
 *   bun run deploy-events:plan
 *   bun run deploy-events:deploy
 */
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect, Layer } from "effect";
import {
  deployEventsDataset,
  deployEventsTokenSecret,
  deployEventsUrlVariable,
} from "./src/infrastructure/deploy-events.ts";
import { stackState } from "./src/infrastructure/state.ts";

export default Alchemy.Stack(
  "executor-next-deploy-events",
  {
    providers: Layer.mergeAll(Axiom.providers(), GitHub.providers()),
    state: stackState,
  },
  Effect.gen(function* () {
    const owner = yield* Config.NonEmptyString("GITHUB_OWNER");
    const repository = yield* Config.NonEmptyString("GITHUB_REPOSITORY_NAME");

    const dataset = yield* Axiom.Dataset("DeployEvents", {
      name: deployEventsDataset,
      kind: "axiom:events:v1",
      description: "One event per attempt of the production Deploy workflow",
    }).pipe(retain());
    // Axiom returns the token's value once, on creation, so Alchemy copies it into the secret.
    // Named through the dataset's output, so the token is created after the dataset it names.
    const ingest = yield* Axiom.ApiToken("DeployEventsIngest", {
      name: `${deployEventsDataset}-ingest`,
      datasetCapabilities: dataset.name.pipe(
        Output.map((name) => ({ [name]: { ingest: ["create" as const] } })),
      ),
    }).pipe(retain());
    yield* GitHub.Secret(deployEventsTokenSecret, {
      owner,
      repository,
      name: deployEventsTokenSecret,
      value: ingest.token,
    }).pipe(retain());
    // The dataset's own edge deployment ingests its events.
    yield* GitHub.Variable(deployEventsUrlVariable, {
      owner,
      repository,
      name: deployEventsUrlVariable,
      value: dataset.edgeDeploymentUrl.pipe(
        Output.map((url) => `${url.replace(/\/$/u, "")}/v1/ingest/${deployEventsDataset}`),
      ),
    }).pipe(retain());

    return {
      dataset: deployEventsDataset,
      repository: `${owner}/${repository}`,
      secret: deployEventsTokenSecret,
      variable: deployEventsUrlVariable,
    };
  }),
);
