/** Headless entry retained for local process supervisors; serves like `executor serve`. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { serveProcess } from "./implementation/server-process.ts";

NodeRuntime.runMain(
  Effect.scoped(serveProcess({ mode: "foreground", platform: process.platform })).pipe(
    Effect.provide(NodeServices.layer),
  ),
);
