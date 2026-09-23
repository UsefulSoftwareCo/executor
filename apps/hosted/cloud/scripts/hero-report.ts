/** Read native PostHog results. Alchemy alone owns provisioning. */
import { isDeepStrictEqual } from "node:util";
import { parseArgs } from "node:util";
import { Config, Console, Context, Effect, Layer } from "effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { postHogProviderCredentials } from "../src/infrastructure/posthog-provider.ts";
import {
  heroExperimentDefinition,
  nativeHeroExperiment,
} from "../src/infrastructure/posthog-experiment.ts";

class Client extends Context.Service<Client, Effect.Success<typeof nativeHeroExperiment>>()(
  "HeroExperimentClient",
) {}

const program = Effect.gen(function* () {
  const { values } = parseArgs({
    options: { project: { type: "string" } },
  });
  if (values.project === undefined || !/^[1-9]\d*$/.test(values.project))
    return yield* Effect.die("Pass --project <PostHog project ID>");
  const project = Number(values.project);
  const api = yield* Client;
  const experiment = yield* api.find(project, heroExperimentDefinition.feature_flag_key);
  if (experiment === undefined)
    return yield* Effect.die(
      "The native hero experiment has not been provisioned; deploy alchemy.posthog.ts",
    );
  const host = yield* Config.NonEmptyString("POSTHOG_HOST");
  yield* Console.log(
    JSON.stringify({
      id: experiment.id,
      url: `${host}/project/${project}/experiments/${experiment.id}`,
      configurationMatchesCode: isDeepStrictEqual(experiment.definition, heroExperimentDefinition),
      featureFlagActive: experiment.flag.active,
      ...(yield* api.results(project, experiment)),
    }),
  );
}).pipe(
  Effect.provide(postHogProviderCredentials(Layer.effect(Client, nativeHeroExperiment))),
  Effect.scoped,
);
NodeRuntime.runMain(program);
