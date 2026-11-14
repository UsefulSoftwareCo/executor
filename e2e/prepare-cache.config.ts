import { defineConfig } from "vitest/config";

/**
 * Runs `scripts/e2e-prepare.ts` and `packages/telemetry/scripts/build-collector.ts` as processes in
 * fake repositories with fake build steps and tools.
 */
export default defineConfig({
  test: {
    include: ["e2e/tests/prepare-cache.spec.ts", "e2e/tests/collector-build.spec.ts"],
    testTimeout: 60_000,
  },
});
