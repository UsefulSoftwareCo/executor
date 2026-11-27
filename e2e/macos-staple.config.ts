import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/macos-staple.spec.ts"],
    testTimeout: 60_000,
  },
});
