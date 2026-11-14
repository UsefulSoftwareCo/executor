/**
 * Read an onboarding experiment's native PostHog results: `--experiment order` (the default) or
 * `skip`. Alchemy alone owns provisioning.
 */
import { isDeepStrictEqual, parseArgs } from "node:util";
import { Config, Console, Context, Effect, Layer } from "effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { postHogProviderCredentials } from "../src/infrastructure/posthog-provider.ts";
import {
  nativeExperiments,
  onboardingExperimentDefinition,
  onboardingSkipExperimentDefinition,
} from "../src/infrastructure/posthog-experiment.ts";

class Client extends Context.Service<Client, Effect.Success<typeof nativeExperiments>>()(
  "OnboardingExperimentClient",
) {}

const program = Effect.gen(function* () {
  const { values } = parseArgs({
    options: { project: { type: "string" }, experiment: { type: "string", default: "order" } },
  });
  const definitions = {
    order: onboardingExperimentDefinition,
    skip: onboardingSkipExperimentDefinition,
  } as const;
  if (values.experiment !== "order" && values.experiment !== "skip")
    return yield* Effect.die("Pass --experiment order or --experiment skip");
  const definition = definitions[values.experiment];
  if (values.project === undefined || !/^[1-9]\d*$/.test(values.project))
    return yield* Effect.die("Pass --project <PostHog project ID>");
  const project = Number(values.project);
  const api = yield* Client;
  const experiment = yield* api.find(project, definition.feature_flag_key);
  if (experiment === undefined)
    return yield* Effect.die(
      "The onboarding experiment has not been provisioned; deploy alchemy.posthog.ts",
    );
  const host = yield* Config.NonEmptyString("POSTHOG_HOST");
  yield* Console.log(
    JSON.stringify({
      id: experiment.id,
      url: `${host}/project/${project}/experiments/${experiment.id}`,
      configurationMatchesCode: isDeepStrictEqual(experiment.definition, definition),
      featureFlagActive: experiment.flag.active,
      ...(yield* api.results(project, experiment)),
    }),
  );
}).pipe(
  Effect.provide(postHogProviderCredentials(Layer.effect(Client, nativeExperiments))),
  Effect.scoped,
);
NodeRuntime.runMain(program);
