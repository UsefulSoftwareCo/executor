import { defineConfig } from "vitest/config";
import { snapshotUpdate } from "./snapshot-updates.ts";
import { Schema } from "effect";
import { Target } from "./report-model.ts";
import { filesForTarget, patternForTarget } from "./test-plan.ts";
import { hookTimeoutMs, scenarioTimeoutMs } from "./timeouts.ts";

const directory = process.env.EXECUTOR_E2E_RUN;
if (!directory) throw new Error("Use bun run e2e to start an isolated target first.");
const target = Schema.decodeUnknownSync(Target)(process.env.E2E_TARGET);
const suite = Schema.decodeUnknownSync(Schema.Literals(["all", "hosted"]))(process.env.E2E_SUITE);
const cloudMode = Schema.decodeUnknownSync(
  Schema.Literals([
    "managed",
    "attached",
    "rate-limited",
    "rolled-back",
    "oauth-proxy-preview",
    "revocation-budget",
    "empty-release-notes",
    "fix-release-notes",
    "feature-release-notes",
  ]),
)(process.env.E2E_CLOUD_MODE);
export default defineConfig({
  test: {
    update: snapshotUpdate(),
    name: target,
    setupFiles: ["e2e/setup.ts"],
    include: filesForTarget(target, suite, cloudMode, process.env.E2E_TEST_NAME ?? ""),
    testNamePattern: patternForTarget(target, suite, process.env.E2E_TEST_NAME ?? "", cloudMode),
    fileParallelism: true,
    maxWorkers: Schema.decodeUnknownSync(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
    )(Number(process.env.E2E_WORKERS)),
    testTimeout: process.env.E2E_INTERACTIVE === "1" ? 0 : scenarioTimeoutMs,
    hookTimeout: hookTimeoutMs,
    teardownTimeout: 30000,
    retry: 0,
    reporters: [
      "verbose",
      ["json", { outputFile: `${directory}/report/diagnostics/results.json` }],
    ],
  },
});
