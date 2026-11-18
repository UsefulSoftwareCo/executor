import { defineConfig } from "vitest/config";

/** Runs `e2e/coverage.ts collect` on run folders holding JSON files it cannot read. */
export default defineConfig({
  test: { include: ["e2e/tests/coverage-unreadable.spec.ts"], testTimeout: 120_000 },
});
