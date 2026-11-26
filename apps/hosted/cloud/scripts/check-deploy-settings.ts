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
