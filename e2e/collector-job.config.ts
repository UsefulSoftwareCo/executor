import { defineConfig } from "vitest/config";

/** Runs the release packaging jobs' wait for their collector job as a process against a local jobs API. */
export default defineConfig({
  test: { include: ["e2e/tests/collector-job.spec.ts"], testTimeout: 60_000 },
});
