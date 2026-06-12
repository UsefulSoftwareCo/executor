// The eval matrix: task × model × trial, each trial a real OpenCode session
// with real Go-subscription inference against the selfhost target. Pass rates
// aggregate into runs/evals/report.{json,md}; every trial keeps its raw event
// stream for post-mortems. Gated on EVAL=1 — never part of the PR path.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTarget } from "../targets/registry";
import { hasOpenCode } from "../src/clients/opencode";
import {
  evalModels,
  evalTrials,
  evalsEnabled,
  hasGoSubscription,
  runTrial,
  type EvalTask,
  type GradeCheck,
} from "./harness";
import { connectHandoffTask, credentialHygieneTask, mintEmulatorApiKey } from "./tasks";
import { Effect } from "effect";
import { RUNS_DIR } from "../src/scenario";

const enabled = evalsEnabled() && hasOpenCode() && hasGoSubscription();
const models = evalModels();
const trials = evalTrials();

const EVALS_DIR = join(RUNS_DIR, "evals");

interface TrialRecord {
  readonly task: string;
  readonly model: string;
  readonly trial: number;
  readonly pass: boolean;
  readonly checks: readonly GradeCheck[];
  readonly durationMs: number;
}

const records: TrialRecord[] = [];

const slug = (text: string) => text.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase();

// Sequential on purpose: `opencode mcp auth` binds a FIXED localhost callback
// port (19876), so concurrent trials race each other's OAuth hop and 400.
const runMatrix = (
  taskName: string,
  makeTask: (secret: string) => Promise<{ task: EvalTask; secret: string }>,
) => {
  describe.runIf(enabled).each(models.map((model) => ({ model })))(
    `${taskName} · $model`,
    { timeout: 360_000 * trials },
    ({ model }) => {
      it.each(Array.from({ length: trials }, (_, i) => ({ trial: i + 1 })))(
        "trial $trial",
        { timeout: 360_000 },
        async ({ trial }) => {
          const target = resolveTarget();
          const secret = await mintEmulatorApiKey();
          const { task } = await makeTask(secret);
          const integration = `evalresend_${slug(model).slice(-8)}_${trial}_${Date.now() % 1e5}`;

          const identity = await Effect.runPromise(target.newIdentity());
          const result = await Effect.runPromise(
            runTrial({
              serverName: "executor",
              mcpUrl: target.mcpUrl,
              model,
              prompt: task.prompt({ integration }),
              identity,
              timeoutMs: task.timeoutMs,
            }),
          );

          // Authenticated API fetch for outcome grading.
          const headers = identity.headers ?? {};
          const apiGet = async (path: string): Promise<unknown> => {
            const response = await fetch(new URL(path, target.baseUrl), { headers });
            if (!response.ok) throw new Error(`${path} → ${response.status}`);
            return response.json();
          };

          const checks = await task.grade(
            { trial: result, target, identity, apiGet },
            { integration },
          );
          const pass = checks.every((c) => c.pass);

          // Artifacts: raw event stream + grade breakdown, one dir per trial.
          const dir = join(EVALS_DIR, slug(`${task.id}-${model}-t${trial}`));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "events.jsonl"), result.rawStdout);
          writeFileSync(
            join(dir, "grade.json"),
            JSON.stringify(
              { task: task.id, model, trial, pass, checks, durationMs: result.durationMs },
              null,
              2,
            ),
          );

          records.push({
            task: task.id,
            model,
            trial,
            pass,
            checks,
            durationMs: result.durationMs,
          });

          // A single trial failing is information, not a gate — the suite
          // asserts on the aggregate below. Still surface the breakdown.
          expect(checks, `grade for ${task.id} on ${model} (trial ${trial})`).toSatisfy(() => true);
          if (!pass) {
            console.warn(
              `[eval] FAIL ${task.id} · ${model} · trial ${trial}:`,
              checks
                .filter((c) => !c.pass)
                .map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`),
            );
          }
        },
      );
    },
  );
};

runMatrix("connect-handoff", async () => ({ task: connectHandoffTask, secret: "" }));
runMatrix("credential-hygiene", async (secret) => ({
  task: credentialHygieneTask(secret),
  secret,
}));

// ---------------------------------------------------------------------------
// Aggregate report — written after all trials; the only hard assertion is
// "every task×model passed at least once" (catastrophic-regression floor).
// ---------------------------------------------------------------------------

describe.runIf(enabled)("report", () => {
  it("aggregates pass rates", () => {
    mkdirSync(EVALS_DIR, { recursive: true });
    const cells = new Map<string, { pass: number; total: number }>();
    for (const r of records) {
      const key = `${r.task} × ${r.model}`;
      const cell = cells.get(key) ?? { pass: 0, total: 0 };
      cell.total += 1;
      if (r.pass) cell.pass += 1;
      cells.set(key, cell);
    }

    const lines = ["# Eval report", "", `Generated: ${new Date().toISOString()}`, ""];
    lines.push("| task × model | pass rate |", "| --- | --- |");
    for (const [key, cell] of cells) {
      lines.push(`| ${key} | ${cell.pass}/${cell.total} |`);
    }
    writeFileSync(join(EVALS_DIR, "report.md"), lines.join("\n"));
    writeFileSync(
      join(EVALS_DIR, "report.json"),
      JSON.stringify({ generated: new Date().toISOString(), records }, null, 2),
    );

    for (const [key, cell] of cells) {
      expect(cell.pass, `${key} should pass at least once in ${cell.total} trials`).toBeGreaterThan(
        0,
      );
    }
  });
});
