import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs the isolate telemetry probe on the workerd local Cloud uses, against a collector it holds. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/telemetry-event-lifetime.spec.ts"],
    testTimeout: 90_000,
  },
});
