import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";
export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/billing.spec.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
