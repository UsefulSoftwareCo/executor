import { defineConfig } from "vitest/config";

/** Runs CI's program that tells a repeated pull request run as a process, as CI does. */
export default defineConfig({
  test: { include: ["e2e/tests/ci-repeat.spec.ts"], testTimeout: 30_000 },
});
