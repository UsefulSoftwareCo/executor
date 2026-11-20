import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the CLI's output module in a child whose stderr is a full pipe, and checks it exits. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/process-output-exit.spec.ts"],
    testTimeout: 60_000,
  },
});
