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
    include: filesForTarget(target, suite, cloudMode),
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: process.env.E2E_INTERACTIVE === "1" ? 0 : 180000,
    hookTimeout: 60000,
    teardownTimeout: 30000,
    retry: 0,
    reporters: [
      "verbose",
      ["html", { outputDir: `${directory}/report/diagnostics`, singleFile: true }],
    ],
  },
});
