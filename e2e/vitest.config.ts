import { defineConfig } from "vitest/config";
import { Schema } from "effect";
import { Target } from "./report-model.ts";
import { filesForTarget } from "./test-plan.ts";

// Vitest's process boundary receives an explicit target and output directory from run.ts.
const directory = process.env.EXECUTOR_E2E_RUN;
if (!directory) throw new Error("Use bun run e2e to start an isolated target first.");
const target = Schema.decodeUnknownSync(Target)(process.env.E2E_TARGET);
const suite = Schema.decodeUnknownSync(Schema.Literals(["all", "hosted"]))(process.env.E2E_SUITE);
const cloudMode = Schema.decodeUnknownSync(Schema.Literals(["managed", "attached"]))(
  process.env.E2E_CLOUD_MODE,
);
export default defineConfig({
  test: {
    name: target,
    setupFiles: ["e2e/setup.ts"],
    include: filesForTarget(target, suite, cloudMode, process.env.E2E_TEST_NAME ?? ""),
    fileParallelism: true,
    maxWorkers: Schema.decodeUnknownSync(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
    )(Number(process.env.E2E_WORKERS)),
    testTimeout: process.env.E2E_INTERACTIVE === "1" ? 0 : 60000,
    hookTimeout: 60000,
    teardownTimeout: 30000,
    retry: 0,
    reporters: [
      "verbose",
      ["json", { outputFile: `${directory}/report/diagnostics/results.json` }],
    ],
  },
});
