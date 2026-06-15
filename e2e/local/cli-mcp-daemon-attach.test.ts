// Local CLI: MCP clients commonly install `executor mcp` as a stdio command.
// When a durable local daemon is already running, that command should attach to
// the daemon's HTTP MCP endpoint instead of starting a second local server and
// tripping the data-dir singleton guard.
import { expect } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";

import { scenario } from "../src/scenario";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const testScope = join(repoRoot, "apps/local");
const readyTimeoutMs = 60_000;

const waitForDaemonReady = (
  proc: Subprocess<"ignore", "pipe", "pipe">,
): Promise<{ readonly port: number; readonly stderr: () => string }> =>
  // oxlint-disable-next-line executor/no-promise-reject -- boundary: local e2e watches a real daemon process
  new Promise((resolveReady, rejectReady) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const decoder = new TextDecoder();
    const stdout = proc.stdout.getReader();
    const stderr = proc.stderr.getReader();

    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: local e2e failure includes captured daemon stderr
      rejectReady(new Error(`daemon did not announce ready: ${stderrBuffer}`));
    }, readyTimeoutMs);

    void (async () => {
      while (true) {
        const { value, done } = await stderr.read();
        if (done) return;
        stderrBuffer += decoder.decode(value);
      }
    })();

    void (async () => {
      while (true) {
        const { value, done } = await stdout.read();
        if (done) {
          if (!settled) {
            settled = true;
            clearTimeout(deadline);
            // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: local e2e failure includes captured daemon stderr
            rejectReady(new Error(`daemon stdout closed before ready: ${stderrBuffer}`));
          }
          return;
        }

        stdoutBuffer += decoder.decode(value);
        const match = /Daemon ready on http:\/\/(?:\[[^\]]+\]|[^:\s]+):(\d+)/.exec(stdoutBuffer);
        if (match) {
          settled = true;
          clearTimeout(deadline);
          resolveReady({ port: Number(match[1]), stderr: () => stderrBuffer });
          return;
        }
      }
    })();
  });

const stopDaemonProcess = async (
  proc: Subprocess<"ignore", "pipe", "pipe">,
  exitCode: () => number | null,
): Promise<void> => {
  if (exitCode() !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([proc.exited, Bun.sleep(3000)]);
  if (exitCode() === null) proc.kill("SIGKILL");
};

const withTempRoot = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-local-mcp-daemon-attach-"))),
  (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
);

const startForegroundDaemon = (dataDir: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "dev:cli",
          "daemon",
          "run",
          "--foreground",
          "--port",
          "0",
          "--hostname",
          "127.0.0.1",
          "--scope",
          testScope,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      let exitCode: number | null = null;
      void proc.exited.then((code) => {
        exitCode = code;
      });

      const ready = yield* Effect.promise(() => waitForDaemonReady(proc)).pipe(
        Effect.tapError(() => Effect.promise(() => stopDaemonProcess(proc, () => exitCode))),
      );
      return { proc, port: ready.port, stderr: ready.stderr, exitCode: () => exitCode };
    }),
    ({ proc, exitCode }) => Effect.promise(() => stopDaemonProcess(proc, exitCode)),
  );

scenario(
  "Local CLI MCP · stdio attaches to the active daemon instead of starting a competing server",
  { timeout: 120_000 },
  Effect.gen(function* () {
    const root = yield* withTempRoot;
    const dataDir = join(root, "data");
    const daemon = yield* startForegroundDaemon(dataDir);

    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "dev:cli", "mcp", "--scope", testScope],
      cwd: repoRoot,
      env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
      stderr: "pipe",
    });
    const client = new Client({ name: "e2e-local-mcp-daemon-attach", version: "1.0.0" });

    yield* Effect.acquireRelease(
      Effect.promise(() => client.connect(transport)),
      () => Effect.promise(() => transport.close()),
    );

    const { tools } = yield* Effect.promise(() => client.listTools());
    expect(
      tools.map((tool) => tool.name),
      "daemon-backed stdio MCP lists tools",
    ).toContain("execute");

    const result = yield* Effect.promise(() =>
      client.callTool({
        name: "execute",
        arguments: { code: "return 2 + 2" },
      }),
    );

    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text, "execute ran through the daemon-backed MCP bridge").toContain("4");
    expect(result.isError, "execute should not report a tool error").toBeFalsy();
    expect(daemon.exitCode(), daemon.stderr()).toBeNull();
    expect(daemon.port, "daemon announced an OS-assigned port").toBeGreaterThan(0);
  }).pipe(Effect.scoped),
);
