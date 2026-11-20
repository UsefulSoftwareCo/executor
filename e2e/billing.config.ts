import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";
/** Requires a separately running isolated Cloudflare host and Autumn sandbox credentials. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/billing.spec.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
