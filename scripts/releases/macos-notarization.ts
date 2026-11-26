import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { waitForNotarization } from "./macos-signing.ts";

const [file] = process.argv.slice(2);
NodeRuntime.runMain(
  (file === undefined
    ? Effect.die(new Error("Usage: macos-notarization.ts <submission file>"))
    : waitForNotarization(file)
  ).pipe(Effect.provide(NodeServices.layer)),
);
