import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The browser suite drives a real Chromium through playwright-core against
    // a real vite dev server and a real MCP server; it is slower than the unit
    // tests but is the only end-to-end proof the shell actually renders.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
