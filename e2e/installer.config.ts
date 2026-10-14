import { defineConfig } from "vitest/config";

/** Runs the docs' install scripts against a local copy of a release download. */
export default defineConfig({
  test: { include: ["e2e/tests/installer.spec.ts"], testTimeout: 300_000 },
});
