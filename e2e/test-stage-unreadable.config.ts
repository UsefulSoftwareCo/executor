import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/test-stage-unreadable.spec.ts"],
    testTimeout: 120_000,
    sequence: { concurrent: true },
  },
});
