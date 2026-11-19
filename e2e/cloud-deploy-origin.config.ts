import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the Cloud deploy workflow's settings check as a process with each kind of public origin. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/cloud-deploy-origin.spec.ts"],
    testTimeout: 60_000,
  },
});
