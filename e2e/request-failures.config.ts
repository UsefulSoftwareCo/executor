import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Fails emulator and product calls against a local server, one way per path, as the harness makes them. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/request-failures.spec.ts"],
    testTimeout: 30_000,
  },
});
