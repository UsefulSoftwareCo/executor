import { defineConfig } from "vitest/config";

/** Builds the Cloud dashboard twice with different build ids and compares its browser files. */
export default defineConfig({
  test: { include: ["e2e/tests/dashboard-file-names.spec.ts"], testTimeout: 900_000 },
});
