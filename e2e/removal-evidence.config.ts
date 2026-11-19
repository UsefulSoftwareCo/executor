import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Saves a stalled organization removal's records from a local stand-in for Cloudflare's API. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/removal-evidence.spec.ts"],
    testTimeout: 30_000,
  },
});
