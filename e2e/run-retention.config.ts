import { defineConfig } from "vitest/config";

/** Starts `e2e/run.ts` in a fake workspace holding old run folders and reads which remain. */
export default defineConfig({
  test: { include: ["e2e/tests/run-retention.spec.ts"], testTimeout: 60_000 },
});
