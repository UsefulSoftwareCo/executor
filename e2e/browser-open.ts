/** The isolated client's OS browser handler forwards its actual launch request to the test driver. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem } from "effect";

const forward = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Config.String("E2E_BROWSER_REQUEST");
  const origin = yield* Config.String("E2E_BROWSER_ORIGIN");
  const argument = process.argv
    .slice(2)
    .find((value) => value.startsWith("http://") || value.startsWith("https://"));
  const url = argument ? URL.parse(argument) : null;
  if (!url || url.origin !== origin || url.pathname !== "/api/auth/oauth2/authorize")
    return yield* Effect.fail(new Error("Client requested an unexpected browser destination"));
  // Rename makes the handoff atomic; the reader never sees a partial authorization URL.
  yield* fs.writeFileString(`${output}.pending`, JSON.stringify({ url: url.href }), {
    mode: 0o600,
  });
  yield* fs.rename(`${output}.pending`, output);
});
NodeRuntime.runMain(
  forward.pipe(
    Effect.provide(NodeServices.layer),
    Effect.catch(() =>
      Console.error("Unable to hand the client's browser request to the test driver").pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  ),
);
