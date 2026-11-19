import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs `scripts/export-public.sh` against local repositories and a stub `gh`, as the export workflow does. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/export-public.spec.ts"],
    testTimeout: 60_000,
  },
});
