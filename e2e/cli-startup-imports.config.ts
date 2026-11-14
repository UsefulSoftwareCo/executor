import { defineConfig } from "vitest/config";

/** Runs the CLI under Node and checks which modules `executor --help` loads. */
export default defineConfig({
  test: { include: ["e2e/tests/cli-startup-imports.spec.ts"], testTimeout: 60_000 },
});
