/** CLI adapter: one deployment is shared by every selected Cloud scenario. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { runDeployedSuite } from "./sdk/deployed-suite.ts";
const command = Command.make(
  "e2e-deployed",
  {
    database: Flag.Literals("database", ["neon", "planetscale"]).pipe(Flag.withDefault("neon")),
    name: Flag.String("test-name").pipe(Flag.withDefault("^(?!.*Claude Code connects)")),
    workers: Flag.Int("workers").pipe(Flag.withDefault(4)),
  },
  runDeployedSuite,
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
