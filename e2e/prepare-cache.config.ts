import { defineConfig } from "vitest/config";

/** Runs `scripts/e2e-prepare.ts` as a process in a fake repository with fake build steps. */
export default defineConfig({
  test: { include: ["e2e/tests/prepare-cache.spec.ts"], testTimeout: 60_000 },
});
