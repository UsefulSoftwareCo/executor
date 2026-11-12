import { defineConfig } from "vitest/config";

/** In-process checks of the MCP transport patched in `patches/effect@4.0.1.patch`. */
export default defineConfig({
  test: { include: ["e2e/tests/effect-mcp-session-bound.spec.ts"], testTimeout: 60_000 },
});
