import { defineConfig } from "vitest/config";

/** Runs the test stage's branch removal against a local stand-in for PlanetScale's API. */
export default defineConfig({
  test: { include: ["e2e/tests/test-stage-branch.spec.ts"], testTimeout: 90_000 },
});
