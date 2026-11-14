import { defineConfig } from "vitest/config";

/** Reports orphaned E2E PlanetScale branches against a local stand-in for PlanetScale's API. */
export default defineConfig({
  test: { include: ["e2e/tests/test-stage-orphans.spec.ts"], testTimeout: 30_000 },
});
