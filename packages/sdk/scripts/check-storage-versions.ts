/**
 * Checks that every SDK storage version built with `indexOnlyVersion` has exactly the tables of
 * the version before it. The hosted migration defers trailing index-only versions until after its
 * product steps, so a deferred version that changed tables would run those steps before its
 * tables exist. Loading the storage module runs the check on the real versions; first the same
 * check runs on check-storage-versions-fixtures.ts, lists it must reject and ones it must accept.
 */
import {
  IndexOnlyVersionChangesTables,
  trailingIndexVersions,
  trailingStorageIndexVersions,
} from "../src/implementation/storage-migrations.ts";
import { fixtures, type Fixture } from "./check-storage-versions-fixtures.ts";

const outcome = (fixture: Fixture) => {
  try {
    return `accepted, trailing [${[...trailingIndexVersions(fixture.schemas)].join(", ")}]`;
  } catch (error) {
    if (error instanceof IndexOnlyVersionChangesTables) return `rejected ${error.version}`;
    throw error;
  }
};
const wrong = fixtures.flatMap((fixture) => {
  const expected =
    "rejects" in fixture
      ? `rejected ${fixture.rejects}`
      : `accepted, trailing [${fixture.trailing.join(", ")}]`;
  const actual = outcome(fixture);
  return actual === expected ? [] : [`${fixture.name}: expected ${expected}, got ${actual}`];
});
if (wrong.length > 0) {
  console.error(
    "The storage version check is wrong about these fixtures (packages/sdk/scripts/check-storage-versions-fixtures.ts):",
  );
  for (const problem of wrong) console.error(`  ${problem}`);
  process.exit(1);
}

const rejected = fixtures.filter((fixture) => "rejects" in fixture).length;
console.log(
  `Index-only storage versions change no tables; trailing: ${[...trailingStorageIndexVersions].join(", ") || "none"} (the check rejects ${rejected} fixtures and accepts ${fixtures.length - rejected}).`,
);
