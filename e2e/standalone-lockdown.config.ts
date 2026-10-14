import { defineConfig } from "vitest/config";

/** Starts the release executable with each Bun override a local process could set. */
export default defineConfig({
  test: { include: ["e2e/tests/standalone-lockdown.spec.ts"], testTimeout: 180_000 },
});
