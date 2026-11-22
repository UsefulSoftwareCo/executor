import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Starts fixture stand-ins that exit, stall or stay silent, and checks the failure says which. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/fixture-start.spec.ts"],
    testTimeout: 30_000,
  },
});
