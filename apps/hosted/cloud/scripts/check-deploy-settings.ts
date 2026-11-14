/**
 * The deploy workflow's first step: refuse settings the stage's Worker would refuse at startup,
 * before anything builds or deploys. `alchemy.run.ts` runs the same checks for every deploy, and
 * reads the public origin (`BETTER_AUTH_URL` outside test stages) the same way.
 * Reads the stage from `ALCHEMY_STAGE` and the settings from the environment.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect } from "effect";
import { productionOAuthProxyCheck } from "../src/infrastructure/deploy-settings.ts";
import { cloudOrigin } from "../src/infrastructure/stage.ts";

NodeRuntime.runMain(
  productionOAuthProxyCheck.pipe(
    Effect.andThen(cloudOrigin),
    Effect.andThen(Console.log("Deploy settings are valid.")),
  ),
);
