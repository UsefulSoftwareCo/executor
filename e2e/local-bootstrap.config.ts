import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["e2e/tests/local-bootstrap.spec.ts"], testTimeout: 120_000 },
});
