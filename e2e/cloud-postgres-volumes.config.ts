import { defineConfig } from "vitest/config";

/** Runs the rule that decides which Cloud test database volumes a run may sweep. */
export default defineConfig({
  test: {
    include: ["e2e/tests/cloud-postgres-volumes.spec.ts"],
    testTimeout: 30_000,
  },
});
