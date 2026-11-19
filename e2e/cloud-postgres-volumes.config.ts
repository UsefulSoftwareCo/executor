import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the rule that decides which Cloud test database volumes a run may sweep. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/cloud-postgres-volumes.spec.ts"],
    testTimeout: 30_000,
  },
});
