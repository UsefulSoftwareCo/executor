import { Effect } from "effect";
import { OwnerId } from "../packages/sdk/src/contracts/shared.ts";
import { storageSchemas } from "../packages/sdk/src/implementation/storage-migrations.ts";
import { hostDataStepNames } from "../packages/app-management/src/implementation/host-data-steps.ts";
import { fixtures } from "./check-local-data-steps-fixtures.ts";

const storage = "4.0.11";
const step = "7_local_owners";

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
