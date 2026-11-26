import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

export default defineConfig({
  test: {
    update: snapshotUpdate(),
    include: ["e2e/tests/desktop-next-server.spec.ts"],
    testTimeout: 30_000,
  },
});
