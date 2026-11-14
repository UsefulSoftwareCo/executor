/**
 * Wait for the notarization a packaging run submitted with `--submission=<file>`, and fail unless
 * Apple accepted it: `node scripts/releases/macos-notarization.ts <file>`. The release workflow
 * runs it after the desktop build and its checks, before uploading what it publishes.
 */
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
