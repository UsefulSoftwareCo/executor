import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { ConfigProvider, Effect, Layer, Redacted, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { readEvidence } from "../e2e/evidence-results.ts";
import { startManagedServer } from "../e2e/support/managed-server.ts";

test("failed startup retains the final child output before releasing its scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "executor-startup-output-"));
  try {
    const entry = join(directory, "failed-startup.mjs");
    await writeFile(
      entry,
      `for (let i = 0; i < 300; i++) console.error("startup diagnostic " + i); process.exitCode = 1;`,
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        startManagedServer({
          directory,
          metadata: {
            target: "local",
            origin: "http://127.0.0.1:0",
            mode: "managed",
            runtime: "Synthetic startup failure",
            commit: "synthetic",
            dirty: false,
            startedAt: "2026-01-01T00:00:00Z",
            interactive: false,
            diagnostics: "diagnostics/results.json",
          },
          apiKey: Redacted.make("synthetic"),
          rows: 1000,
          observeUI: false,
          recordingPaceMs: 0,
        }),
      ).pipe(
        Effect.result,
        Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ EXECUTOR_E2E_LOCAL_ENTRY: entry })),
        ),
      ),
    );
    assert.ok(Result.isFailure(result));
    const logs = await readFile(join(directory, "server.log"), "utf8");
    assert.match(logs, /startup diagnostic 299\n$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native failures override successful capture and include failed setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "executor-report-"));
  try {
    await mkdir(join(directory, "report/evidence/captured"), { recursive: true });
    const saved = {
      id: "captured",
      title: "cleanup fails",
      file: "fixture.spec.ts",
      target: "local",
      status: "passed",
      duration: 10,
      errors: [],
      annotations: [],
      attachments: [],
    };
    await writeFile(join(directory, "report/evidence/captured/result.json"), JSON.stringify(saved));
    const read = () =>
      Effect.runPromise(readEvidence(directory).pipe(Effect.provide(NodeServices.layer)));
    assert.deepEqual(await read(), [saved], "Interactive capture works without Vitest");
    await writeFile(
      join(directory, "run.json"),
      JSON.stringify({
        target: "local",
        origin: "http://127.0.0.1:1234",
        mode: "managed",
        runtime: "test",
        commit: "synthetic",
        dirty: false,
        startedAt: "2026-01-01T00:00:00Z",
        interactive: false,
        diagnostics: "diagnostics/results.json",
      }),
    );
    await mkdir(join(directory, "report/diagnostics"));
    await writeFile(
      join(directory, "report/diagnostics/results.json"),
      JSON.stringify({
        testResults: [
          {
            name: "/synthetic/fixture.spec.ts",
            assertionResults: [
              {
                title: "cleanup fails",
                status: "failed",
                duration: 30,
                failureMessages: ["Cleanup deadline"],
              },
              {
                title: "setup fails",
                status: "failed",
                duration: null,
                failureMessages: ["Startup failure"],
              },
              { title: "not selected", status: "pending", failureMessages: [] },
            ],
          },
        ],
      }),
    );
    const entries = await read();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      ...saved,
      status: "failed",
      duration: 30,
      errors: ["Cleanup deadline"],
    });
    assert.equal(entries[1]?.title, "setup fails");
    assert.equal(entries[1]?.status, "failed");
    assert.deepEqual(entries[1]?.errors, ["Startup failure"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unavailable HTTPS origin fails native setup without stopping independent scenarios", async () => {
  await mkdir(".local", { recursive: true });
  const directory = await mkdtemp(resolve(".local/preparation-report-"));
  const blocked = "a".repeat(32);
  const ready = "b".repeat(32);
  const output = join(directory, "results.json");
  try {
    await writeFile(
      join(directory, "run.json"),
      JSON.stringify({
        target: "cloud",
        origin: "https://fixture.example.test",
        mode: "attached",
        runtime: "Synthetic preparation failure",
        commit: "synthetic",
        dirty: false,
        startedAt: "2026-01-01T00:00:00Z",
        interactive: false,
        diagnostics: "diagnostics/results.json",
      }),
    );
    const fixture = join(directory, "preparation.spec.ts");
    await writeFile(
      fixture,
      `import { it, expect } from "vitest";
import { installScenarioLifecycle, scenarioLifetime } from ${JSON.stringify(pathToFileURL(resolve("e2e/support/lifecycle.ts")).href)};
installScenarioLifecycle();
it("blocked domain", () => { throw new Error("The scenario body must not run"); });
it("independent scenario", (context) => {
  expect(scenarioLifetime(context).target.scenarioId).toBe(${JSON.stringify(ready)});
});
`,
    );
    const config = join(directory, "vitest.config.ts");
    await writeFile(
      config,
      `export default { test: {
        include: [${JSON.stringify(fixture)}],
        retry: 0,
        maxWorkers: 1,
        reporters: [["json", { outputFile: ${JSON.stringify(output)} }]]
      } };`,
    );
    const result = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--config", config],
      {
        encoding: "utf8",
        timeout: 30000,
        env: {
          ...process.env,
          EXECUTOR_E2E_RUN: directory,
          EXECUTOR_E2E_API_KEY: "synthetic",
          E2E_RECORDING_PACE_MS: "0",
          E2E_FIXTURES: "",
          E2E_PREPARED_SCENARIOS: JSON.stringify({
            "blocked domain": { id: blocked, status: "domain_unavailable" },
            "independent scenario": { id: ready, status: "ready" },
          }),
        },
      },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.numFailedTests, 1);
    assert.equal(report.numPassedTests, 1);
    const failed = report.testResults[0].assertionResults.find(
      (entry: { title: string }) => entry.title === "blocked domain",
    );
    assert.equal(failed.status, "failed");
    assert.match(failed.failureMessages.join("\n"), /HTTPS app origin was not ready/);
    assert.doesNotMatch(failed.failureMessages.join("\n"), /The scenario body must not run/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
