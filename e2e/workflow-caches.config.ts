import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Reads the workflows to check which code can write the caches runs on main restore. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/workflow-caches.spec.ts"],
    testTimeout: 30_000,
  },
});
