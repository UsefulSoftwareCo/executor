/** CLI composition root; command declarations have no import-time side effects. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Schema } from "effect";
import { CliError, Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { TestStageFailed } from "../src/contracts/test-stage-lifetime.ts";
import { testStageCommand } from "../src/implementation/test-stage-commands.ts";

NodeRuntime.runMain(
  Command.run(testStageCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.catch((error) => {
      if (CliError.isCliError(error)) return Effect.fail(error);
      return Console.error(
        Schema.is(TestStageFailed)(error)
          ? error.message
          : "Test-stage command failed. Check the required configuration and service access.",
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      );
    }),
  ),
);
