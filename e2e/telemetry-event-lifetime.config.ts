import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/telemetry-event-lifetime.spec.ts"],
    testTimeout: 90_000,
  },
});
