import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs test-stage cleanup's app domain deletion against a local stand-in for Cloudflare's API. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/test-stage-domain-cleanup.spec.ts"],
    testTimeout: 60_000,
  },
});
