import { defineConfig } from "vitest/config";

/** Runs the leftover conflict marker check on this checkout and on a planted conflict. */
export default defineConfig({
  test: { include: ["e2e/tests/conflict-markers.spec.ts"], testTimeout: 60_000 },
});
