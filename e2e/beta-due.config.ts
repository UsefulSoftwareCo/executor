import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs `scripts/releases/beta-due.ts` against a scratch repository and stub `gh` and `npm`, as the beta workflow does. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/beta-due.spec.ts"],
    testTimeout: 60_000,
  },
});
