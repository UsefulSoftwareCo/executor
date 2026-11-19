import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs `e2e/coverage.ts collect` on run folders holding JSON files it cannot read. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/coverage-unreadable.spec.ts"],
    testTimeout: 120_000,
  },
});
