/**
 * Report orphaned deployed-E2E PlanetScale branches for a given set of stage leases, as scheduled
 * cleanup does with the registry's leases (`test-stage cleanup`). It only reads. Prints
 * `{"orphans": [...]}`, or `{"skipped": true}` when no test database is configured; a failure
 * prints its message and exits 1.
 *
 *   node scripts/test-stage-orphans.ts [--leases e2e-a,e2e-b] [--now <epoch ms>]
 *
 * `test-stage-orphans.spec.ts` runs it against a local stand-in for PlanetScale's API.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Clock, Console, Effect, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { findOrphanBranches } from "../src/implementation/test-stage-orphans.ts";

const option = (name: string) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

NodeRuntime.runMain(
  Effect.gen(function* () {
    const leases = new Set(
      (option("--leases") ?? "").split(",").filter((slug) => slug.trim() !== ""),
    );
    const given = option("--now");
    const now = given === undefined ? yield* Clock.currentTimeMillis : Number(given);
    const found = yield* findOrphanBranches(leases, now);
    yield* Console.log(
      JSON.stringify(Option.isSome(found) ? { orphans: found.value } : { skipped: true }),
    );
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
