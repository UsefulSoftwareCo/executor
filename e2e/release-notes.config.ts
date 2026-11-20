import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/**
 * Runs `scripts/releases/release-notes.ts` against scratch main and public repositories, as a
 * publishing run does. Each case has its own repositories, so four run at once, one per vCPU of the
 * tooling runner.
 */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/release-notes.spec.ts"],
    testTimeout: 60_000,
    sequence: { concurrent: true },
    maxConcurrency: 4,
  },
});
