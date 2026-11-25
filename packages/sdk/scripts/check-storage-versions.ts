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
