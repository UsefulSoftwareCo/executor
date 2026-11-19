import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Starts `e2e/run.ts` in a fake workspace holding old run folders and reads which remain. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/run-retention.spec.ts"],
    testTimeout: 60_000,
  },
});
