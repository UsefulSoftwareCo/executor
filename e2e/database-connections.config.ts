import { defineConfig } from "vitest/config";

/** The deployed run's connection-latency levels and its check that teardown deleted the branch. */
export default defineConfig({
  test: { include: ["e2e/tests/database-connections.spec.ts"], testTimeout: 30_000 },
});
