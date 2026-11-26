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
