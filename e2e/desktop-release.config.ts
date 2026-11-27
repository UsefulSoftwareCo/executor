import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";
export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/desktop-release.spec.ts"],
    testTimeout: 120_000,
    globalSetup: ["e2e/desktop-close-durations.ts"],
  },
});
