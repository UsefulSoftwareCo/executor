import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs `scripts/typecheck.ts` as a process with fake compilers, the way `bun run check` does. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/typecheck-runner.spec.ts"],
    testTimeout: 30_000,
  },
});
