import { defineConfig } from "vitest/config";

/** Runs the selection that removes a test stage by name against recorded copies of its APIs. */
export default defineConfig({
  test: {
    include: ["e2e/tests/test-stage-unreadable.spec.ts"],
    testTimeout: 120_000,
    // Each case has its own recorded APIs and registry, and most of its time is waiting.
    sequence: { concurrent: true },
  },
});
