import { defineConfig } from "vitest/config";

/** Runs local Cloud's patched Worker proxy in Node and Bun in front of a fake workerd. */
export default defineConfig({
  test: { include: ["e2e/tests/cloud-proxy-keep-alive.spec.ts"], testTimeout: 90_000 },
});
