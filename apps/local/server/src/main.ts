/** Headless entry retained for local process supervisors; shares the CLI's server lifecycle. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { launch } from "./implementation/launcher.ts";

NodeRuntime.runMain(
  Effect.scoped(launch("headless", process.platform)).pipe(Effect.provide(NodeServices.layer)),
);
