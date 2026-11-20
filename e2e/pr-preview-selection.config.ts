import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the PR preview workflow's decision to deploy, retire or remove a preview, as a process. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/pr-preview-selection.spec.ts"],
    testTimeout: 30_000,
  },
});
