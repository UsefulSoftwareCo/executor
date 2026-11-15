import { defineConfig } from "vitest/config";

/** Runs the publish job's channel guard and failure report against a local stub of each public surface. */
export default defineConfig({
  test: { include: ["e2e/tests/publish-guard.spec.ts"], testTimeout: 90_000 },
});
