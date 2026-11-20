import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the release packaging jobs' wait for their collector job as a process against a local jobs API. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/collector-job.spec.ts"],
    testTimeout: 60_000,
  },
});
