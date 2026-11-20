import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the patched alchemy's watcher in Node processes, the way the dev sidecar does. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/alchemy-first-builds.spec.ts"],
    testTimeout: 60_000,
  },
});
