/** Explicit CLI adapter for rendering a saved suite, including downloaded CI artifacts. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { renderSuiteEvidence } from "./sdk/render-evidence.ts";

const command = Command.make(
  "e2e-render",
  { directory: Flag.String("directory").pipe(Flag.withDescription("Saved suite run directory")) },
  ({ directory }) => renderSuiteEvidence(directory),
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(Effect.provide(NodeServices.layer)),
);
