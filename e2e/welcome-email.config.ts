import { defineConfig } from "vitest/config";

/** Uses a separately running, isolated Alchemy cloud dev host with local mail capture. */
export default defineConfig({
  test: {
    include: ["e2e/tests/welcome-email.spec.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
