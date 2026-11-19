import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the release workflow's part results checks (e2e/part-results.ts) as processes. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/part-results.spec.ts"],
    testTimeout: 60_000,
  },
});
