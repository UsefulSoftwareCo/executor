import { defineConfig } from "vitest/config";

// failure-evidence.spec.ts runs these cases in their own process, with EXECUTOR_E2E_RUN set to a
// run directory of their own, and reads the results and evidence they leave there.
const directory = process.env.EXECUTOR_E2E_RUN;
if (!directory) throw new Error("failure-evidence.spec.ts starts these cases.");
export default defineConfig({
  test: {
    setupFiles: ["e2e/setup.ts"],
    include: ["e2e/failure-evidence/cases.ts"],
    // Each case starts its own product; running them together keeps the scenario short.
    sequence: { concurrent: true },
    maxConcurrency: 4,
    testTimeout: 60000,
    hookTimeout: 60000,
    retry: 0,
    reporters: [["json", { outputFile: `${directory}/results.json` }]],
  },
});
