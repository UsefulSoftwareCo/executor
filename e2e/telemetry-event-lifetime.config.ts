import { defineConfig } from "vitest/config";

/** Runs the isolate telemetry probe on the workerd local Cloud uses, against a collector it holds. */
export default defineConfig({
  test: { include: ["e2e/tests/telemetry-event-lifetime.spec.ts"], testTimeout: 60_000 },
});
