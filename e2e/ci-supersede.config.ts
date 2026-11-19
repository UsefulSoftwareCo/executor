import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs CI's program that cancels a pull request's runs on older heads as a process, as CI does. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/ci-supersede.spec.ts"],
    testTimeout: 30_000,
  },
});
