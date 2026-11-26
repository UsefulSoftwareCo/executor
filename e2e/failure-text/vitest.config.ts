import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "../snapshot-updates.ts";

const directory = process.env.EXECUTOR_E2E_RUN;
if (!directory) throw new Error("failure-text.spec.ts starts these cases.");
export default defineConfig({
  test: {
    update: snapshotUpdate(),
    setupFiles: ["e2e/setup.ts"],
    include: ["e2e/failure-text/cases.ts"],
    sequence: { concurrent: true },
    maxConcurrency: 4,
    testTimeout: 60000,
    hookTimeout: 60000,
    retry: 0,
    reporters: ["verbose", ["json", { outputFile: `${directory}/results.json` }]],
  },
});
