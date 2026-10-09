import { defineConfig } from "vitest/config";

/** Runs the apps release check as a process against a local registry that replays npm. */
export default defineConfig({
  test: { include: ["e2e/tests/apps-published.spec.ts"], testTimeout: 90_000 },
});
