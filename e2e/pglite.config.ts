import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/pglite-results.spec.ts", "e2e/tests/local-database-first-start.spec.ts"],
    testTimeout: 60_000,
  },
});
