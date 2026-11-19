import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** In-process checks of what `patches/effect@4.1.4.patch` changes: the MCP transport and the semaphore. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: [
      "e2e/tests/effect-mcp-session-bound.spec.ts",
      "e2e/tests/effect-semaphore-queue.spec.ts",
    ],
    testTimeout: 60_000,
  },
});
