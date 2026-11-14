import { defineConfig } from "vitest/config";

/** Runs the CLI's output module in a child whose stderr is a full pipe, and checks it exits. */
export default defineConfig({
  test: { include: ["e2e/tests/process-output-exit.spec.ts"], testTimeout: 60_000 },
});
