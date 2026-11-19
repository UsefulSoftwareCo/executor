import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the macOS staple repeat and the patched @electron/notarize against a stub xcrun. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/macos-staple.spec.ts"],
    testTimeout: 60_000,
  },
});
