import { defineConfig } from "vitest/config";

/** Runs the PR preview workflow's decision to deploy, retire or remove a preview, as a process. */
export default defineConfig({
  test: { include: ["e2e/tests/pr-preview-selection.spec.ts"], testTimeout: 30_000 },
});
