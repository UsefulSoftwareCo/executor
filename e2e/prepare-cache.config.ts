import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/**
 * Runs `scripts/e2e-prepare.ts` and `packages/telemetry/scripts/build-collector.ts` as processes in
 * fake repositories with fake build steps and tools.
 */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/prepare-cache.spec.ts", "e2e/tests/collector-build.spec.ts"],
    testTimeout: 60_000,
  },
});
