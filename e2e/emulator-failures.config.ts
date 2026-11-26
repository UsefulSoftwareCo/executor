import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/emulator-failures.spec.ts"],
    testTimeout: 30_000,
  },
});
