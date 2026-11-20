import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** What the webhook waits conclude from the sweep's passes, from synthetic spans. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/webhook-sweep-waits.spec.ts"],
    testTimeout: 30_000,
  },
});
