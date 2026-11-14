import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["e2e/tests/desktop-release.spec.ts"],
    testTimeout: 120_000,
    // Prints each desktop close's duration in the job's log.
    globalSetup: ["e2e/desktop-close-durations.ts"],
  },
});
