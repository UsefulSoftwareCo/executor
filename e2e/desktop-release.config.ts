import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["e2e/tests/desktop-release.spec.ts"], testTimeout: 120_000 },
});
