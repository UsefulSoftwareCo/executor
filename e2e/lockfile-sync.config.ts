import { defineConfig } from "vitest/config";

/** Runs `scripts/check-lockfile.ts` and `scripts/releases/lock-repair.sh` in scratch Bun workspaces. */
export default defineConfig({
  test: { include: ["e2e/tests/lockfile-sync.spec.ts"], testTimeout: 60_000 },
});
