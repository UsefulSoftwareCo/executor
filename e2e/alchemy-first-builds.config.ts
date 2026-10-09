import { defineConfig } from "vitest/config";

/** Runs the patched alchemy's watcher in Node processes, the way the dev sidecar does. */
export default defineConfig({
  test: { include: ["e2e/tests/alchemy-first-builds.spec.ts"], testTimeout: 60_000 },
});
