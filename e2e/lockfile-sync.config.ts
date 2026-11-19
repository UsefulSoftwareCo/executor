import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs `scripts/check-lockfile.ts` and `scripts/releases/lock-repair.sh` in scratch Bun workspaces. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/lockfile-sync.spec.ts"],
    testTimeout: 60_000,
  },
});
