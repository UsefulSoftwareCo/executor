import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the release's wait for npm's dist-tags against a local registry that replays npm. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/npm-channel.spec.ts"],
    testTimeout: 60_000,
  },
});
