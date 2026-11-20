import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Checks that no Vitest run in e2e/ writes a snapshot unless asked (e2e/snapshot-updates.ts). */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/snapshot-updates.spec.ts"],
    testTimeout: 60_000,
  },
});
