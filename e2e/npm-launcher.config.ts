import { defineConfig } from "vitest/config";

/** Starts the packed npm launcher through each entry point a command shim may name. */
export default defineConfig({
  test: { include: ["e2e/tests/npm-launcher.spec.ts"], testTimeout: 180_000 },
});
