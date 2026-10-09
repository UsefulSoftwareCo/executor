import { defineConfig } from "vitest/config";

/** Reads a child's piped output the way the managed local Cloud reads `alchemy dev`'s. */
export default defineConfig({
  test: { include: ["e2e/tests/alchemy-dev-output.spec.ts"], testTimeout: 30_000 },
});
