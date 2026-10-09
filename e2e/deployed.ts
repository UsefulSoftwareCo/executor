/** CLI adapter: one deployment is shared by every selected Cloud scenario. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { runDeployedSuite } from "./sdk/deployed-suite.ts";
import { deployedSuitePattern } from "./test-plan.ts";
const command = Command.make(
  "e2e-deployed",
  {
    database: Flag.Literals("database", ["neon", "planetscale"]).pipe(Flag.withDefault("neon")),
    name: Flag.String("test-name").pipe(Flag.withDefault(deployedSuitePattern)),
    workers: Flag.Int("workers").pipe(Flag.withDefault(16)),
  },
  runDeployedSuite,
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
