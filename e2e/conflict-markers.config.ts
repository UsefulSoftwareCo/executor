import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the leftover conflict marker check on this checkout and on a planted conflict. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/conflict-markers.spec.ts"],
    testTimeout: 60_000,
  },
});
