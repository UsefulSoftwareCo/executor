import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Starts the packed npm launcher through each entry point a command shim may name. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/npm-launcher.spec.ts"],
    testTimeout: 180_000,
  },
});
