import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "e2e/tests/docker-release.spec.ts",
      "e2e/tests/docker-release-workflow-memory.spec.ts",
      "e2e/tests/docker-release-workflow-restart.spec.ts",
      "e2e/tests/docker-release-workflow-stopped.spec.ts",
      "e2e/tests/docker-oauth-renewal.spec.ts",
      "e2e/tests/workflow-engine.spec.ts",
    ],
    testTimeout: 180_000,
  },
});
