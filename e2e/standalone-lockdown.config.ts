import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Starts the release executable with each Bun override a local process could set. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/standalone-lockdown.spec.ts"],
    testTimeout: 180_000,
  },
});
