import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs patched Playwright and Chromium against a local server while routes come and go. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/playwright-routes.spec.ts"],
    testTimeout: 180_000,
  },
});
