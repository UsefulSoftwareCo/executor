import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** A stage request lost on a dropped kept-alive connection, against a local stand-in stage. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/lost-connections.spec.ts"],
    testTimeout: 30_000,
  },
});
