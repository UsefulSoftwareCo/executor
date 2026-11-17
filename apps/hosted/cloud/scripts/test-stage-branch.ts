/**
 * Remove one deployed E2E stage's PlanetScale branch by its exact name, as `test-stage destroy`
 * does after Alchemy's destroy (test-stage-branch.ts). Prints the outcome, its message and whether
 * the stage's lease would be kept; exits 1 unless the branch is gone.
 *
 *   node scripts/test-stage-branch.ts --slug e2e-abc123
 *
 * `TEST_STAGE_BRANCH_POLL` (a duration, 5 seconds by default) sets how often it reads the branch.
 *
 * `test-stage-branch.spec.ts` runs it against a local stand-in for PlanetScale's API; the API
 * override accepts only a loopback origin (test-stage-orphans.ts).
 */
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
