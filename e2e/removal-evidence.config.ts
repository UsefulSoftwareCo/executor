import { defineConfig } from "vitest/config";

/** Saves a stalled organization removal's records from a local stand-in for Cloudflare's API. */
export default defineConfig({
  test: { include: ["e2e/tests/removal-evidence.spec.ts"], testTimeout: 30_000 },
});
