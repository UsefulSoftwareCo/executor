import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the release workflow's failed-scenario evidence gathering (e2e/release-evidence.ts). */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/release-evidence.spec.ts"],
    testTimeout: 60_000,
  },
});
