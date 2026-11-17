import { defineConfig } from "vitest/config";

/** What the webhook waits conclude from the sweep's passes, from synthetic spans. */
export default defineConfig({
  test: { include: ["e2e/tests/webhook-sweep-waits.spec.ts"], testTimeout: 30_000 },
});
