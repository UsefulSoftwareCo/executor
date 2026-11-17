import { defineConfig } from "vitest/config";

/** A stage request lost on a dropped kept-alive connection, against a local stand-in stage. */
export default defineConfig({
  test: { include: ["e2e/tests/lost-connections.spec.ts"], testTimeout: 30_000 },
});
