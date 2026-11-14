import { defineConfig } from "vitest/config";

/** Runs the Cloud deploy workflow's settings check as a process with each kind of public origin. */
export default defineConfig({
  test: { include: ["e2e/tests/cloud-deploy-origin.spec.ts"], testTimeout: 60_000 },
});
