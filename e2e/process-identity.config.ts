import { defineConfig } from "vitest/config";

/** Runs the background service harness's process identity rule against real processes. */
export default defineConfig({
  test: {
    include: ["e2e/tests/process-identity.spec.ts"],
    testTimeout: 30_000,
  },
});
