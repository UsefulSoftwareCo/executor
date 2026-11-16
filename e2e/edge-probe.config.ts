import { defineConfig } from "vitest/config";

/** The temporary edge probe (scripts/ci/edge-probe.ts) against local stand-ins for the edge. */
export default defineConfig({
  test: { include: ["e2e/tests/edge-probe.spec.ts"], testTimeout: 60_000 },
});
