import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** The deployed run's connection-latency levels and its check that teardown deleted the branch. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/database-connections.spec.ts"],
    testTimeout: 30_000,
  },
});
