import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Builds the Cloud dashboard twice with different build ids and compares its browser files. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/dashboard-file-names.spec.ts"],
    testTimeout: 900_000,
  },
});
