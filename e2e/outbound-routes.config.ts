import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Runs Cloud's outbound routes and relay objects on the workerd local Cloud uses, against a service it holds. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/outbound-routes.spec.ts"],
    testTimeout: 120_000,
  },
});
