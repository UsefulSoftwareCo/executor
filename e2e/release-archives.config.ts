import { defineConfig } from "vitest/config";

/** Runs the release archive digest check as a process, the way the archives job does. */
export default defineConfig({
  test: { include: ["e2e/tests/release-archives.spec.ts"], testTimeout: 60_000 },
});
