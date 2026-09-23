/** CLI adapter for the shared suite lifecycle. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { runSuite } from "./sdk/suite.ts";
const command = Command.make(
  "e2e",
  {
    target: Flag.Literals("target", ["self-host", "local", "cloud", "all", "hosted"]).pipe(
      Flag.withDefault("self-host"),
    ),
    name: Flag.String("test-name").pipe(Flag.withDefault("")),
    workers: Flag.Int("workers").pipe(Flag.withDefault(4)),
  },
  runSuite,
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
