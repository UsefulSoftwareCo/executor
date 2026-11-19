import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the apps version bump check as a process on staged packages written beforehand. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/apps-bumped.spec.ts"],
    testTimeout: 60_000,
  },
});
