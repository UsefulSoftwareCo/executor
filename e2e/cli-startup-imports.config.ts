import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the CLI under Node and checks which modules `executor --help` loads. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/cli-startup-imports.spec.ts"],
    testTimeout: 60_000,
  },
});
