import { defineConfig } from "vitest/config";

/**
 * In-process checks of the PGlite build the self-host product bundles, and of how the local and
 * self-hosted servers create their PGlite databases.
 */
export default defineConfig({
  test: {
    include: ["e2e/tests/pglite-results.spec.ts", "e2e/tests/local-database-first-start.spec.ts"],
    testTimeout: 60_000,
  },
});
