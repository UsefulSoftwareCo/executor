import { defineConfig } from "vitest/config";

/** Runs `scripts/typecheck.ts` as a process with fake compilers, the way `bun run check` does. */
export default defineConfig({
  test: { include: ["e2e/tests/typecheck-runner.spec.ts"], testTimeout: 30_000 },
});
