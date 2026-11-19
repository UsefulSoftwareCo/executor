import { defineConfig } from "vitest/config";

/**
 * Runs CI's program that tells a repeated pull request run as a process, as CI does. Each case has
 * its own stub `gh` and answers, so two run at once; with four, its longest cases neared their limit
 * on four busy cores.
 */
export default defineConfig({
  test: {
    include: ["e2e/tests/ci-repeat.spec.ts"],
    testTimeout: 30_000,
    sequence: { concurrent: true },
    maxConcurrency: 2,
  },
});
