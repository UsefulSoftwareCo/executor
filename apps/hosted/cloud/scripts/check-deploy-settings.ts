/**
 * The deploy workflow's first step: refuse settings the stage's Worker would refuse at startup,
 * before anything builds or deploys. `alchemy.run.ts` runs the same checks for every deploy, and
 * reads the public origin (`BETTER_AUTH_URL` outside test stages) the same way.
 * Reads the stage from `ALCHEMY_STAGE` and the settings from the environment, Cloud's notes file
 * (`EXECUTOR_CLOUD_RELEASE_NOTES_FILE`) included, which production must have.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect } from "effect";
import { productionOAuthProxyCheck } from "../src/infrastructure/deploy-settings.ts";
import { cloudReleaseNotesInput } from "../src/infrastructure/release-notes.ts";
import { cloudOrigin } from "../src/infrastructure/stage.ts";

NodeRuntime.runMain(
  productionOAuthProxyCheck.pipe(
    Effect.andThen(cloudOrigin),
    Effect.andThen(cloudReleaseNotesInput),
    Effect.andThen(Console.log("Deploy settings are valid.")),
    Effect.provide(NodeServices.layer),
  ),
);
