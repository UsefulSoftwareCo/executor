import { defineConfig } from "vitest/config";

/** Runs the desktop recovery harness's server matching against a stub server and `server.json`. */
export default defineConfig({
  test: {
    include: ["e2e/tests/desktop-next-server.spec.ts"],
    testTimeout: 30_000,
  },
});
