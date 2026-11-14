/**
 * Composition root for PR lifecycle discovery and preview verification. `prepare` and `previewed`
 * import no package: the preview workflow runs them before it installs dependencies, and the other
 * commands load Effect only when they run.
 */
import { runSelection } from "../src/implementation/pr-preview-decision.ts";

const [command, ...args] = process.argv.slice(2);
if (command === "prepare" || command === "previewed") {
  process.exitCode = await runSelection(command, args, process.env);
} else {
  const [NodeRuntime, NodeServices, { Console, Effect, Schema }, { CliError, Command }] =
    await Promise.all([
      import("@effect/platform-node/NodeRuntime"),
      import("@effect/platform-node/NodeServices"),
      import("effect"),
      import("effect/cli"),
    ]);
  const { FetchHttpClient } = await import("effect/http");
  const { TestStageFailed } = await import("../src/contracts/test-stage-lifetime.ts");
  const { prPreviewCommand } = await import("../src/implementation/pr-preview-commands.ts");
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
}
