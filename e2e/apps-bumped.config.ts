import { defineConfig } from "vitest/config";

/** Runs the apps version bump check as a process on staged packages written beforehand. */
export default defineConfig({
  test: { include: ["e2e/tests/apps-bumped.spec.ts"], testTimeout: 60_000 },
});
