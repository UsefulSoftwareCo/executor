import { defineConfig } from "vitest/config";

/** Uses separately owned Cloud dev/preview hosts; select the matching scenario with -t. */
export default defineConfig({
  test: {
    include: ["e2e/tests/welcome-email.spec.ts", "e2e/tests/test-stage-email.spec.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
