import { defineConfig } from "vitest/config";

/** Runs patched Playwright and Chromium against a local server while routes come and go. */
export default defineConfig({
  test: { include: ["e2e/tests/playwright-routes.spec.ts"], testTimeout: 180_000 },
});
