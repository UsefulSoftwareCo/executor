/** Composition root for PR lifecycle discovery and preview verification. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Console, Effect, Schema } from "effect";
import { CliError, Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { TestStageFailed } from "../src/contracts/test-stage-lifetime.ts";
import { prPreviewCommand } from "../src/implementation/pr-preview-commands.ts";

NodeRuntime.runMain(
  Command.run(prPreviewCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.catch((error) => {
      if (CliError.isCliError(error)) return Effect.fail(error);
      return Console.error(
        Schema.is(TestStageFailed)(error)
          ? error.message
          : "PR preview command failed. Check GitHub and staging access.",
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
