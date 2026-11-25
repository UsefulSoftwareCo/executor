import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/chatgpt-sign-in.spec.ts"],
    maxWorkers: 1,
    testTimeout: 60_000,
  },
});
