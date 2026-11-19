import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the test stage's branch removal against a local stand-in for PlanetScale's API. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/test-stage-branch.spec.ts"],
    testTimeout: 90_000,
  },
});
