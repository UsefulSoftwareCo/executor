import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/desktop-update.spec.ts"],
    testTimeout: 240_000,
    globalSetup: ["e2e/desktop-close-durations.ts"],
  },
});
