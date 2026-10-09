/** CLI composition root; command declarations have no import-time side effects. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Schema } from "effect";
import { CliError, Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import {
  McpSessionReleaseBlocked,
  releaseRefusedExitStatus,
} from "../src/contracts/release-guard.ts";
import { TestStageFailed } from "../src/contracts/test-stage-lifetime.ts";
import { testStageCommand } from "../src/implementation/test-stage-commands.ts";

NodeRuntime.runMain(
  Command.run(testStageCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.catch((error) => {
      if (CliError.isCliError(error)) return Effect.fail(error);
      const refused = Schema.is(McpSessionReleaseBlocked)(error);
      return Console.error(
        refused || Schema.is(TestStageFailed)(error)
          ? error.message
          : "Test-stage command failed. Check the required configuration and service access.",
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = refused ? releaseRefusedExitStatus : 1;
          }),
        ),
      );
    }),
  ),
);
