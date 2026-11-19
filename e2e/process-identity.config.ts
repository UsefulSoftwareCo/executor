import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the background service harness's process identity rule against real processes. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/process-identity.spec.ts"],
    testTimeout: 30_000,
  },
});
