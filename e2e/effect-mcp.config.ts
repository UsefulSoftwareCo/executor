import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: [
      "e2e/tests/effect-mcp-session-bound.spec.ts",
      "e2e/tests/effect-semaphore-queue.spec.ts",
    ],
    testTimeout: 60_000,
  },
});
