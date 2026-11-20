import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/**
 * In-process checks of the PGlite build the self-host product bundles, and of how the local and
 * self-hosted servers create their PGlite databases.
 */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/pglite-results.spec.ts", "e2e/tests/local-database-first-start.spec.ts"],
    testTimeout: 60_000,
  },
});
