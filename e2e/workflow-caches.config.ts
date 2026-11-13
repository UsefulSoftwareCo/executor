import { defineConfig } from "vitest/config";

/** Reads the workflows to check which code can write the caches runs on main restore. */
export default defineConfig({
  test: { include: ["e2e/tests/workflow-caches.spec.ts"], testTimeout: 30_000 },
});
