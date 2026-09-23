/** A real parent process for testing collector pipe ownership. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, Layer } from "effect";
import { localTelemetry } from "../../src/local.ts";
NodeRuntime.runMain(
  Layer.launch(
    Layer.unwrap(
      Config.String("EXECUTOR_DIAGNOSTICS_TEST_DIR").pipe(
        Effect.map((directory) => localTelemetry(directory, "parent-test")),
      ),
    ),
  ).pipe(Effect.provide(NodeServices.layer)),
);
