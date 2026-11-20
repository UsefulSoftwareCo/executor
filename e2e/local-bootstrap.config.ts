import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/local-bootstrap.spec.ts"],
    testTimeout: 120_000,
  },
});
