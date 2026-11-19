import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/desktop-release.spec.ts"],
    testTimeout: 120_000,
    // Prints each desktop close's duration in the job's log.
    globalSetup: ["e2e/desktop-close-durations.ts"],
  },
});
