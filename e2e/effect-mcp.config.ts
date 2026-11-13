import { defineConfig } from "vitest/config";

/** In-process checks of what `patches/effect@4.1.4.patch` changes: the MCP transport and the semaphore. */
export default defineConfig({
  test: {
    include: [
      "e2e/tests/effect-mcp-session-bound.spec.ts",
      "e2e/tests/effect-semaphore-queue.spec.ts",
    ],
    testTimeout: 60_000,
  },
});
