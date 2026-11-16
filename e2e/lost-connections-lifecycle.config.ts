import { defineConfig } from "vitest/config";

/**
 * The lost-request records written by the real scenario lifecycle (`e2e/setup.ts`), against a
 * stand-in stage the global setup starts: one inside a scenario, one in a layer's set-up outside
 * any. The global teardown fails the run when either record was not written.
 */
export default defineConfig({
  test: {
    include: ["e2e/tests/lost-connections-lifecycle.spec.ts"],
    setupFiles: ["e2e/setup.ts"],
    globalSetup: ["e2e/lost-connections-lifecycle.global.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      EXECUTOR_E2E_RUN: ".local/lost-connections-lifecycle/run",
      EXECUTOR_E2E_API_KEY: "synthetic-lost-connections-key",
      E2E_RECORDING_PACE_MS: "0",
    },
  },
});
