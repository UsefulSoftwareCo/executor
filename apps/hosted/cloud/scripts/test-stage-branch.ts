import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Console, Effect, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import {
  branchGone,
  branchOutcomeMessage,
  removeStageBranch,
} from "../src/implementation/test-stage-branch.ts";

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

NodeRuntime.runMain(
  Effect.gen(function* () {
    const slug = option("--slug") ?? "";
    const outcome = yield* removeStageBranch(slug);
    if (Option.isNone(outcome)) return yield* Console.log(JSON.stringify({ skipped: true }));
    const gone = branchGone(outcome.value);
    yield* Console.log(
      JSON.stringify({
        outcome: outcome.value,
        message: branchOutcomeMessage(`test-${slug}`, outcome.value),
        leaseKept: !gone,
      }),
    );
    if (!gone) process.exitCode = 1;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.catch((error) =>
      Console.error(error.message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      ),
    ),
  ),
);
