import { defineConfig } from "vitest/config";

/** Runs the release workflow's part results checks (e2e/part-results.ts) as processes. */
export default defineConfig({
  test: {
    include: ["e2e/tests/part-results.spec.ts"],
    testTimeout: 60_000,
  },
});
