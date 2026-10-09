import { defineConfig } from "vitest/config";

/** Fails emulator calls against a local stand-in for emulators.dev, the way the harness makes them. */
export default defineConfig({
  test: { include: ["e2e/tests/emulator-failures.spec.ts"], testTimeout: 30_000 },
});
