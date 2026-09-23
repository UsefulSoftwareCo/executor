import { defineConfig } from "vitest/config";
/** Requires a separately running isolated Cloudflare host and Autumn sandbox credentials. */
export default defineConfig({
  test: {
    include: ["e2e/tests/billing.spec.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
