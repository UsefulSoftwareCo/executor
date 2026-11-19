import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the publish job's channel guard and failure report against a local stub of each public surface. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/publish-guard.spec.ts"],
    testTimeout: 90_000,
  },
});
