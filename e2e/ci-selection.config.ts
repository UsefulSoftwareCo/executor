import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/**
 * Runs the CI selection program as a process, the way the select job does. Each case has its own
 * scratch directories, stub `gh` and environment, so two run at once. More would not finish sooner
 * on the 4-vCPU tooling runner, whose cores the heaviest cases' own processes already share, and
 * would bring the busiest cases nearer their limits.
 */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/ci-selection.spec.ts"],
    testTimeout: 30_000,
    sequence: { concurrent: true },
    maxConcurrency: 2,
  },
});
