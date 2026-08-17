// Stress for PR 1033 (`executor mcp` attaches to the active local daemon). The
// happy path is covered by cli-mcp-daemon-attach.test.ts; this hammers the
// concurrency the bridge introduced:
//
//   A. ATTACH STORM — one daemon, many stdio bridges at once, each firing a
//      burst of execute() calls. Stresses the StdioServerTransport ↔
//      StreamableHTTPClientTransport forwarding under load and the daemon's MCP
//      session handling. A dropped/misrouted JSON-RPC reply shows up as a wrong
//      or missing result.
//   B. COLD-START RACE — NO daemon, many `executor mcp` started simultaneously.
//      They race acquireLocalServerStartLock + the double-check
//      readActiveLocalServerManifest the PR added: exactly one must start a
//      server, the rest must bridge to it. If the guard is wrong, the losers
//      trip the data-dir singleton ("another active local server") or collide on
//      a port — surfacing as client failures.
//   C. KILL UNDER LOAD — kill the daemon mid-bridge; the http transport's
//      onclose must tear the bridge down so the `executor mcp` process exits
//      instead of hanging (a leaked stdio child per crashed daemon would be the
//      bug).
import { expect } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scenario } from "../src/scenario";
import { stopAutoSpawnedDaemon } from "./daemon-process";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const testScope = join(repoRoot, "apps/local");
// Generous: a dev-mode daemon boots a Vite dev server, slow under machine load.
const readyTimeoutMs = 150_000;

// vitest runs this suite under NODE, not bun, so the daemon is spawned with
// node:child_process (the rest of the e2e harness does the same). `Bun.spawn`
// here threw `ReferenceError: Bun is not defined` on every run.
type DaemonProc = ChildProcessWithoutNullStreams;

const waitForDaemonReady = (
  proc: DaemonProc,
): Promise<{ readonly port: number; readonly stderr: () => string }> =>
  // oxlint-disable-next-line executor/no-promise-reject -- boundary: local e2e watches a real daemon process
  new Promise((resolveReady, rejectReady) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: captured daemon stderr
      rejectReady(new Error(`daemon did not announce ready: ${stderrBuffer}`));
    }, readyTimeoutMs);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });
    proc.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBuffer += chunk.toString();
      const match = /Daemon ready on http:\/\/(?:\[[^\]]+\]|[^:\s]+):(\d+)/.exec(stdoutBuffer);
      if (match) {
        settled = true;
        clearTimeout(deadline);
        resolveReady({ port: Number(match[1]), stderr: () => stderrBuffer });
      }
    });
    proc.stdout.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: captured daemon stderr
      rejectReady(new Error(`daemon stdout closed before ready: ${stderrBuffer}`));
    });
  });

const spawnDaemon = (dataDir: string): DaemonProc =>
  spawn(
    "bun",
    [
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
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  ) as DaemonProc;

const exited = (proc: DaemonProc): Promise<void> =>
  proc.exitCode !== null || proc.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => proc.once("exit", () => resolve()));

const stopProc = async (proc: DaemonProc): Promise<void> => {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (proc.pid) process.kill(-proc.pid, "SIGTERM");
  await Promise.race([exited(proc), new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
    process.kill(-proc.pid, "SIGKILL");
    await exited(proc);
  }
};

const startForegroundDaemon = (dataDir: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const proc = spawnDaemon(dataDir);
      const ready = yield* Effect.promise(() => waitForDaemonReady(proc)).pipe(
        Effect.tapError(() => Effect.promise(() => stopProc(proc))),
      );
      return { proc, port: ready.port, stderr: ready.stderr };
    }),
    ({ proc }) => Effect.promise(() => stopProc(proc)),
  );

interface ClientReport {
  readonly id: number;
  readonly ok: boolean;
  readonly tools: number;
  readonly results: ReadonlyArray<string>;
  readonly error?: string;
}

/** One `executor mcp` stdio bridge: connect, list tools, fire `callCount`
 * execute() calls (each computing a unique value), collect the text results,
 * always close. Never throws — failures are captured in the report so the
 * scenario can assert across the whole fleet. */
const runOneClient = async (
  id: number,
  dataDir: string,
  callCount: number,
): Promise<ClientReport> => {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "dev:cli", "mcp", "--scope", testScope],
    cwd: repoRoot,
    env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
    stderr: "pipe",
  });
  const client = new Client({ name: `stress-client-${id}`, version: "1.0.0" });
  const results: string[] = [];
  let errBuf = "";
  transport.stderr?.on("data", (d: Buffer) => {
    errBuf += d.toString();
  });
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: capture per-client failure for fleet-wide assertions
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (let i = 0; i < callCount; i++) {
      // A value unique to (client, call) so a misrouted reply is detectable.
      const expr = `return ${id} * 1000 + ${i}`;
      const r = await client.callTool({ name: "execute", arguments: { code: expr } });
      const text = (r.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      results.push(text);
    }
    return { id, ok: true, tools: tools.length, results };
  } catch (error) {
    return {
      id,
      ok: false,
      tools: 0,
      results,
      error:
        (error instanceof Error ? error.message : String(error)) +
        (errBuf
          ? `\n     stderr: ${errBuf.trim().split("\n").slice(-6).join("\n             ")}`
          : ""),
    };
  } finally {
    await transport.close().catch(() => undefined);
  }
};

const withTempData = Effect.acquireRelease(
  Effect.sync(() => {
    const root = mkdtempSync(join(tmpdir(), "executor-mcp-stress-"));
    return join(root, "data");
  }),
  (dataDir) =>
    Effect.promise(async () => {
      await stopAutoSpawnedDaemon(dataDir);
      rmSync(join(dataDir, ".."), { recursive: true, force: true });
    }),
);

const summarize = (label: string, reports: ReadonlyArray<ClientReport>): void => {
  const ok = reports.filter((r) => r.ok).length;
  const calls = reports.reduce((n, r) => n + r.results.length, 0);
  const failures = reports.filter((r) => !r.ok).map((r) => `#${r.id}: ${r.error}`);
  // eslint-disable-next-line no-console
  console.log(
    `[stress:${label}] clients ${ok}/${reports.length} ok, ${calls} execute calls` +
      (failures.length ? `\n  failures:\n   ${failures.join("\n   ")}` : ""),
  );
};

const CONCURRENCY = Number(process.env.E2E_MCP_STRESS_CLIENTS ?? "10");
const CALLS = Number(process.env.E2E_MCP_STRESS_CALLS ?? "5");

scenario(
  "Local CLI MCP · an attach storm of concurrent stdio bridges all execute correctly",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const dataDir = yield* withTempData;
    const daemon = yield* startForegroundDaemon(dataDir);

    // Many bridges attach to the one daemon at once and each fires a burst.
    const reports = yield* Effect.promise(() =>
      Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => runOneClient(id, dataDir, CALLS))),
    );
    summarize("attach-storm", reports);

    for (const report of reports) {
      expect(report.ok, `client #${report.id} failed: ${report.error ?? ""}`).toBe(true);
      expect(report.tools, `client #${report.id} listed tools`).toBeGreaterThan(0);
      // Every reply is the value THIS client asked for — no cross-talk between
      // concurrent bridges sharing the daemon.
      report.results.forEach((text, i) => {
        expect(text, `client #${report.id} call ${i} got its own result`).toContain(
          String(report.id * 1000 + i),
        );
      });
    }
    expect(daemon.proc.exitCode, `daemon survived the storm:\n${daemon.stderr()}`).toBeNull();
  }).pipe(Effect.scoped),
);

scenario(
  "Local CLI MCP · a cold-start race elects exactly one server and every client attaches",
  { timeout: 240_000 },
  Effect.gen(function* () {
    const dataDir = yield* withTempData;

    // No daemon: launch the whole fleet simultaneously so they race the
    // start-lock + double-check. Exactly one should start a server; the rest
    // must bridge to it. A broken guard trips the singleton or a port collision.
    const reports = yield* Effect.promise(() =>
      Promise.all(Array.from({ length: CONCURRENCY }, (_, id) => runOneClient(id, dataDir, CALLS))),
    );
    summarize("cold-start-race", reports);

    for (const report of reports) {
      expect(report.ok, `client #${report.id} lost the race: ${report.error ?? ""}`).toBe(true);
      report.results.forEach((text, i) => {
        expect(text, `client #${report.id} call ${i}`).toContain(String(report.id * 1000 + i));
      });
    }

    // Exactly one elected owner: a single server.json manifest, not N competing
    // servers. (The bridges own no DB and write no manifest of their own.)
    const controlDir = join(dataDir, "server-control");
    const serverManifests = (() => {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: dir read
      try {
        return readdirSync(controlDir).filter((f) => f === "server.json");
      } catch {
        return [];
      }
    })();
    expect(serverManifests.length, "exactly one elected server manifest").toBe(1);
  }).pipe(Effect.scoped),
);

scenario(
  "Local CLI MCP · killing the daemon under load tears bridges down without hanging",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const dataDir = yield* withTempData;
    const daemon = yield* startForegroundDaemon(dataDir);

    // Attach a bridge, prove it works, then SIGKILL the daemon out from under it
    // and confirm a subsequent call fails fast (the bridge tore down) rather than
    // hanging until the test times out.
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "dev:cli", "mcp", "--scope", testScope],
      cwd: repoRoot,
      env: { ...process.env, EXECUTOR_DATA_DIR: dataDir },
      stderr: "pipe",
    });
    const client = new Client({ name: "stress-kill", version: "1.0.0" });
    yield* Effect.acquireRelease(
      Effect.promise(() => client.connect(transport)),
      () => Effect.promise(() => transport.close().catch(() => undefined)),
    );

    const first = yield* Effect.promise(() =>
      client.callTool({ name: "execute", arguments: { code: "return 1 + 1" } }),
    );
    expect((first.content as Array<{ text: string }>)[0]?.text, "bridge works pre-kill").toContain(
      "2",
    );

    if (daemon.proc.pid) process.kill(-daemon.proc.pid, "SIGKILL");
    yield* Effect.promise(() =>
      Promise.race([
        exited(daemon.proc),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]),
    );

    // The next call must settle (reject) quickly — a 10s bound well under the
    // scenario timeout catches a hang.
    const settled = yield* Effect.promise(() =>
      Promise.race([
        client
          .callTool({ name: "execute", arguments: { code: "return 3" } })
          .then(() => "resolved" as const)
          .catch(() => "rejected" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
      ]),
    );
    // eslint-disable-next-line no-console
    console.log(`[stress:kill-under-load] post-kill call → ${settled}`);
    expect(settled, "a call after the daemon dies must not hang").not.toBe("timeout");
  }).pipe(Effect.scoped),
);
