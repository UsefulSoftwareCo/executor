import { defineConfig } from "vitest/config";

/** Runs by hand against a deployed stage: local workerd does not enforce the subrequest depth limit. */
export default defineConfig({
  test: {
    include: ["e2e/tests/cloud-mcp-subrequest-depth.spec.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
