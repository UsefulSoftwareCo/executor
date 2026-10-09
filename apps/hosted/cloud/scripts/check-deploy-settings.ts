/**
 * The deploy workflow's first step: refuse settings the stage's Worker would refuse at startup,
 * before anything builds or deploys. `alchemy.run.ts` runs the same check for every deploy.
 * Reads the stage from `ALCHEMY_STAGE` and the settings from the environment.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect } from "effect";
import { productionOAuthProxyCheck } from "../src/infrastructure/deploy-settings.ts";

NodeRuntime.runMain(
  productionOAuthProxyCheck.pipe(Effect.andThen(Console.log("Deploy settings are valid."))),
);
