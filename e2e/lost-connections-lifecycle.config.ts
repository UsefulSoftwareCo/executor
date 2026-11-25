import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
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
