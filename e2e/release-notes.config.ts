import { defineConfig } from "vitest/config";

/** Runs `scripts/releases/release-notes.ts` against scratch main and public repositories, as a publishing run does. */
export default defineConfig({
  test: { include: ["e2e/tests/release-notes.spec.ts"], testTimeout: 60_000 },
});
