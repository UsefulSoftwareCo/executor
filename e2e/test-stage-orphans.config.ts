import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Reports orphaned E2E PlanetScale branches against a local stand-in for PlanetScale's API. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/test-stage-orphans.spec.ts"],
    testTimeout: 30_000,
  },
});
