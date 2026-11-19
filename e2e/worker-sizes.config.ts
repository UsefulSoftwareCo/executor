import { defineConfig } from "vitest/config";

/**
 * Runs the Worker upload size check as a process on uploads written beforehand, without building.
 * Each case has its own directories, stub `gh` and answers, so two run at once.
 */
export default defineConfig({
  test: {
    include: ["e2e/tests/worker-sizes.spec.ts"],
    testTimeout: 30_000,
    sequence: { concurrent: true },
    maxConcurrency: 2,
  },
});
