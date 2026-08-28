import { defineConfig } from "vitest/config";

/** Isolated unit-test config for the CI shard planner. */
export default defineConfig({
  test: {
    include: ["scripts/ci-shard.test.ts"],
    maxWorkers: 1,
  },
});
