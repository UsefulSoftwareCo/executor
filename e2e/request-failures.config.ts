import { defineConfig } from "vitest/config";

/** Fails emulator and product calls against a local server, one way per path, as the harness makes them. */
export default defineConfig({
  test: { include: ["e2e/tests/request-failures.spec.ts"], testTimeout: 30_000 },
});
