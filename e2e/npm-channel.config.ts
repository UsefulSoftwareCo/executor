import { defineConfig } from "vitest/config";

/** Runs the release's wait for npm's dist-tags against a local registry that replays npm. */
export default defineConfig({
  test: { include: ["e2e/tests/npm-channel.spec.ts"], testTimeout: 60_000 },
});
