import { defineConfig } from "vitest/config";

/** Runs the CI selection program as a process, the way the select job does. */
export default defineConfig({
  test: { include: ["e2e/tests/ci-selection.spec.ts"], testTimeout: 30_000 },
});
