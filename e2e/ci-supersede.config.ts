import { defineConfig } from "vitest/config";

/** Runs CI's program that cancels a pull request's runs on older heads as a process, as CI does. */
export default defineConfig({
  test: { include: ["e2e/tests/ci-supersede.spec.ts"], testTimeout: 30_000 },
});
