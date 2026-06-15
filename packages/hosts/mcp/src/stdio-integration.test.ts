import { describe, expect, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliEntry = resolve(repoRoot, "apps/cli/src/main.ts");
const testScope = resolve(repoRoot, "apps/local");
const readyTimeoutMs = 30_000;
type DaemonProcess = ChildProcessByStdio<null, Readable, Readable>;

const waitForDaemonReady = (
  proc: DaemonProcess,
): Promise<{ readonly port: number; readonly stderr: () => string }> =>
  // oxlint-disable-next-line executor/no-promise-reject -- boundary: integration test watches a real daemon process
  new Promise((resolveReady, rejectReady) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(deadline);
      proc.stdout.off("data", onStdout);
      proc.stderr.off("data", onStderr);
      proc.off("error", onError);
      proc.off("close", onClose);
    };

    const fail = (cause: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: adapts child_process callbacks into the Promise waited by the Effect test helper
      rejectReady(cause);
    };

    const deadline = setTimeout(() => {
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: integration test failure includes captured daemon stderr
      fail(new Error(`daemon did not announce ready: ${stderrBuffer}`));
    }, readyTimeoutMs);

    const onStderr = (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    };

    const onStdout = (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      const match = /Daemon ready on http:\/\/(?:\[[^\]]+\]|[^:\s]+):(\d+)/.exec(stdoutBuffer);
      if (match) {
        settled = true;
        cleanup();
        resolveReady({ port: Number(match[1]), stderr: () => stderrBuffer });
      }
    };

    const onError = (error: Error) => fail(error);

    const onClose = () => {
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: integration test failure includes captured daemon stderr
      fail(new Error(`daemon stdout closed before ready: ${stderrBuffer}`));
    };

    proc.stdout.on("data", onStdout);
    proc.stderr.on("data", onStderr);
    proc.once("error", onError);
    proc.once("close", onClose);
  });

const stopDaemonProcess = async (
  proc: DaemonProcess,
  exitCode: () => number | null,
): Promise<void> => {
  if (exitCode() !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => {
      proc.once("close", () => resolve());
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (exitCode() === null) proc.kill("SIGKILL");
};

const startForegroundDaemon = (dataDir: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const proc = spawn(
        "bun",
        [
          "run",
          cliEntry,
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
        { env: { ...process.env, EXECUTOR_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let exitCode: number | null = null;
      proc.once("close", (code) => {
        exitCode = code;
      });

      const ready = yield* Effect.promise(() => waitForDaemonReady(proc)).pipe(
        Effect.tapError(() => Effect.promise(() => stopDaemonProcess(proc, () => exitCode))),
      );
      return { proc, port: ready.port, stderr: ready.stderr, exitCode: () => exitCode };
    }),
    ({ proc, exitCode }) => Effect.promise(() => stopDaemonProcess(proc, exitCode)),
  );

describe("MCP stdio integration", () => {
  it.effect(
    "execute tool returns result over stdio transport",
    () =>
      Effect.gen(function* () {
        // Fresh temp dir so the test doesn't migrate against the developer's
        // real ~/.executor/data.db.
        const dataDir = mkdtempSync(join(tmpdir(), "executor-mcp-test-"));

        const transport = new StdioClientTransport({
          command: "bun",
          args: ["run", cliEntry, "mcp", "--scope", testScope],
          env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
        });

        const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(transport)),
          () => Effect.promise(() => transport.close()),
        );

        const { tools } = yield* Effect.promise(() => client.listTools());
        expect(tools.map((t) => t.name)).toContain("execute");

        const result = yield* Effect.promise(() =>
          client.callTool({
            name: "execute",
            arguments: { code: "return 2+2" },
          }),
        );

        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        expect(text).toContain("4");
        expect(result.isError).toBeFalsy();
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it.effect(
    "attaches stdio MCP to an active local daemon",
    () =>
      Effect.gen(function* () {
        const dataDir = mkdtempSync(join(tmpdir(), "executor-mcp-daemon-test-"));
        const daemon = yield* startForegroundDaemon(dataDir);

        const transport = new StdioClientTransport({
          command: "bun",
          args: ["run", cliEntry, "mcp", "--scope", testScope],
          env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
        });

        const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(transport)),
          () => Effect.promise(() => transport.close()),
        );

        const { tools } = yield* Effect.promise(() => client.listTools());
        expect(tools.map((t) => t.name)).toContain("execute");

        const result = yield* Effect.promise(() =>
          client.callTool({
            name: "execute",
            arguments: { code: "return 2+2" },
          }),
        );

        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        expect(text).toContain("4");
        expect(result.isError).toBeFalsy();
        expect(daemon.exitCode(), daemon.stderr()).toBeNull();
        expect(daemon.port).toBeGreaterThan(0);
      }).pipe(Effect.scoped),
    { timeout: 45_000 },
  );
});
