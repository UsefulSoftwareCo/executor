import { defineConfig } from "vitest/config";

/** Runs `scripts/export-public.sh` against local repositories and a stub `gh`, as the export workflow does. */
export default defineConfig({
  test: { include: ["e2e/tests/export-public.spec.ts"], testTimeout: 60_000 },
});
