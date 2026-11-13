import { defineConfig } from "vitest/config";

/** Runs the deploy's wait for the apps job as a process against a local jobs API. */
export default defineConfig({
  test: { include: ["e2e/tests/apps-job.spec.ts"], testTimeout: 60_000 },
});
