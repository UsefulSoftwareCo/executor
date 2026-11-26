import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/desktop-servers.spec.ts"],
    testTimeout: 300_000,
    fileParallelism: false,
    globalSetup: ["e2e/desktop-close-durations.ts"],
  },
});
