import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/posthog-experiment-lifecycle.spec.ts"],
    testTimeout: 180_000,
  },
});
