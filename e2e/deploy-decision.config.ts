import { defineConfig } from "vitest/config";

/** Runs the Deploy workflow's decision as a process, the way the decide job does. */
export default defineConfig({
  test: { include: ["e2e/tests/deploy-decision.spec.ts"], testTimeout: 60_000 },
});
