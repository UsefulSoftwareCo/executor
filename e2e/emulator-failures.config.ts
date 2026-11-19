import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Fails emulator calls against a local stand-in for emulators.dev, the way the harness makes them. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/emulator-failures.spec.ts"],
    testTimeout: 30_000,
  },
});
