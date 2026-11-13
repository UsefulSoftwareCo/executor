import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "e2e/tests/docker-release.spec.ts",
      "e2e/tests/docker-release-catalog.spec.ts",
      "e2e/tests/docker-release-app-memory.spec.ts",
      "e2e/tests/docker-release-collector-memory.spec.ts",
      "e2e/tests/docker-release-connections.spec.ts",
      "e2e/tests/docker-release-credential-handles.spec.ts",
      "e2e/tests/docker-release-executor-api.spec.ts",
      "e2e/tests/docker-release-trusted-proxies.spec.ts",
      "e2e/tests/docker-release-live-query.spec.ts",
      "e2e/tests/docker-release-mcp-session-release.spec.ts",
      "e2e/tests/docker-release-workflow-memory.spec.ts",
      "e2e/tests/docker-release-workflow-idle-window.spec.ts",
      "e2e/tests/docker-release-workflow-restart.spec.ts",
      "e2e/tests/docker-release-workflow-sleeping.spec.ts",
      "e2e/tests/docker-release-workflow-stopped.spec.ts",
      "e2e/tests/docker-oauth-renewal.spec.ts",
      "e2e/tests/workflow-engine.spec.ts",
    ],
    testTimeout: 180_000,
    // Every Docker network the scenarios use exists before the first starts; see
    // e2e/support/release-networks.ts.
    globalSetup: ["e2e/docker-release-networks.ts"],
  },
});
