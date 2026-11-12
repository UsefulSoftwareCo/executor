import { defineConfig } from "vitest/config";

/** Runs `scripts/releases/beta-due.ts` against a scratch repository and stub `gh` and `npm`, as the beta workflow does. */
export default defineConfig({
  test: { include: ["e2e/tests/beta-due.spec.ts"], testTimeout: 60_000 },
});
