import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Reads a child's piped output the way the managed local Cloud reads `alchemy dev`'s. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/alchemy-dev-output.spec.ts"],
    testTimeout: 30_000,
  },
});
