import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the desktop recovery harness's server matching against a stub server and `server.json`. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/desktop-next-server.spec.ts"],
    testTimeout: 30_000,
  },
});
