import { defineConfig } from "vitest/config";

/** Runs the release workflow's failed-scenario evidence gathering (e2e/release-evidence.ts). */
export default defineConfig({
  test: {
    include: ["e2e/tests/release-evidence.spec.ts"],
    testTimeout: 60_000,
  },
});
