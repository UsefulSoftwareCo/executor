import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";

/** Deploys the Cloud PostHog experiment resource with alchemy against a local stand-in for PostHog. */
export default defineConfig({
  test: {
    // Writes no snapshot unless asked (snapshot-updates.ts).
    update: snapshotUpdate(),
    include: ["e2e/tests/posthog-experiment-lifecycle.spec.ts"],
    testTimeout: 180_000,
  },
});
