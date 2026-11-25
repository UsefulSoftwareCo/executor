import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/prepare-cache.spec.ts", "e2e/tests/collector-build.spec.ts"],
    testTimeout: 60_000,
  },
});
