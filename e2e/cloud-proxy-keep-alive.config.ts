import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs local Cloud's patched Worker proxy in Node and Bun in front of a fake workerd. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/cloud-proxy-keep-alive.spec.ts"],
    testTimeout: 90_000,
  },
});
