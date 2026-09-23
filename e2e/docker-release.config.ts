import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["e2e/tests/docker-release.spec.ts"], testTimeout: 180_000 },
});
