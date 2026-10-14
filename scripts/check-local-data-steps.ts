/**
 * Checks that local lists data step 7 once the SDK's latest storage version is 4.0.11 or later.
 * Every local release before step 7 refuses that storage, which keeps a release that lets agents
 * name any owner from opening a database the step has moved. A release with the storage and
 * without the step would be one, so such a tree must not pass. First the same rule runs on
 * check-local-data-steps-fixtures.ts, trees it must reject and ones it must accept.
 */
import { Effect } from "effect";
import { OwnerId } from "../packages/sdk/src/contracts/shared.ts";
import { storageSchemas } from "../packages/sdk/src/implementation/storage-migrations.ts";
import { hostDataStepNames } from "../packages/app-management/src/implementation/host-data-steps.ts";
import { fixtures } from "./check-local-data-steps-fixtures.ts";

/** The first storage no local release before step 7 opens. History fixes both. */
const storage = "4.0.11";
const step = "7_local_owners";

/** Whether a dotted version is at least another, part by part. */
const atLeast = (version: string, minimum: string) => {
  const have = version.split(".").map(Number);
  const need = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    const left = have[index] ?? 0;
    const right = need[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
};
const rejects = (latest: string, steps: ReadonlyArray<string>) =>
  atLeast(latest, storage) && !steps.includes(step);

const wrong = fixtures.flatMap((fixture) =>
  rejects(fixture.storage, fixture.steps) === fixture.rejects
    ? []
    : [`${fixture.name}: expected ${fixture.rejects ? "rejected" : "accepted"}`],
);
if (wrong.length > 0) {
  console.error(
    "The local data step check is wrong about these fixtures (scripts/check-local-data-steps-fixtures.ts):",
  );
  for (const problem of wrong) console.error(`  ${problem}`);
  process.exit(1);
}

const latest = storageSchemas.at(-1)?.version ?? "";
// Local's journal requires local owners (`runStartupDataSteps`), so this is the list local runs.
const local = hostDataStepNames({
  localOwners: {
    owner: OwnerId.make("local"),
    kept: [],
    storage: Effect.succeed(latest),
    status: () => Effect.void,
  },
});
if (rejects(latest, local)) {
  console.error(
    `SDK storage ${latest} needs local data step ${step}; local lists ${local.join(", ")}. A local release with this storage and without the step would open a database the step has moved and write other owners there.`,
  );
  process.exit(1);
}
console.log(
  `Local lists ${step} on SDK storage ${latest} (the check rejects ${fixtures.filter((fixture) => fixture.rejects).length} fixtures and accepts ${fixtures.filter((fixture) => !fixture.rejects).length}).`,
);
