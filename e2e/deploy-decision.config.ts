import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/**
 * Runs the Deploy workflow's decision as a process, the way the decide job does. Each case has its
 * own repository and stub GitHub, so four run at once, one per vCPU of the tooling runner.
 */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/deploy-decision.spec.ts"],
    testTimeout: 60_000,
    sequence: { concurrent: true },
    maxConcurrency: 4,
  },
});
