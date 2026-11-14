import { defineConfig } from "vitest/config";

// failure-text.spec.ts runs these cases in their own process, with EXECUTOR_E2E_RUN set to a run
// directory of their own, and reads their log, results and evidence.
const directory = process.env.EXECUTOR_E2E_RUN;
if (!directory) throw new Error("failure-text.spec.ts starts these cases.");
export default defineConfig({
  test: {
    setupFiles: ["e2e/setup.ts"],
    include: ["e2e/failure-text/cases.ts"],
    sequence: { concurrent: true },
    maxConcurrency: 4,
    testTimeout: 60000,
    hookTimeout: 60000,
    retry: 0,
    // The same reporters as the suite's, so the log is the one a CI job prints.
    reporters: ["verbose", ["json", { outputFile: `${directory}/results.json` }]],
  },
});
