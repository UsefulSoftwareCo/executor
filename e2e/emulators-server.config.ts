import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the CI runner's emulators.dev server with a stand-in Worker and checks what passes through. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/emulators-server.spec.ts"],
    testTimeout: 60_000,
  },
});
