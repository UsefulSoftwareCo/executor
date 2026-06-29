// Local-only: plain `apps/local` Vite dev must route the same local-only HTTP
// surfaces as production `executor web`. These routes live outside the typed
// `/api` HttpApi: `/api/health`, `/api/oauth/await/*`, and browser approval's
// `/api/mcp-sessions/*`.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { scenario } from "../src/scenario";
import { waitForHttp } from "../setup/boot";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const localAppDir = join(repoRoot, "apps/local");

const APPROVAL_TARGET_TOOL = "executor.coreTools.policies.list";
const EXECUTE_CODE = `
const result = await tools.executor.coreTools.policies.list({});
return JSON.stringify(result);
`;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

const readToken = async (dataDir: string): Promise<string> => {
  const path = join(dataDir, "server-control", "auth.json");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { readonly token?: unknown };
      if (typeof parsed.token === "string") return parsed.token;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite dev did not mint ${path}`);
};

const stopTree = async (child: ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
};

interface ViteDev {
  readonly origin: string;
  readonly token: string;
  readonly stop: () => Promise<void>;
}

const startPlainViteDev = async (): Promise<ViteDev> => {
  const dataDir = mkdtempSync(join(tmpdir(), "executor-local-vite-e2e-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let logs = "";
  const child = spawn(
    "bunx",
    ["--bun", "vite", "dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: localAppDir,
      env: { ...process.env, EXECUTOR_DATA_DIR: dataDir, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    logs += chunk.toString();
  });

  try {
    await waitForHttp(origin, { timeoutMs: 90_000 });
    const token = await readToken(dataDir);
    return {
      origin,
      token,
      stop: async () => {
        await stopTree(child);
        rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopTree(child);
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`plain Vite dev failed to boot:\n${logs}\n${String(error)}`);
  }
};

scenario(
  "Local Vite dev · local-only API routes match production routing",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const vite = yield* Effect.promise(() => startPlainViteDev());
    yield* Effect.promise(async () => {
      const failures: string[] = [];
      let policyId: string | null = null;
      const auth = { authorization: `Bearer ${vite.token}` };

      try {
        const health = await fetch(`${vite.origin}/api/health`);
        const healthText = await health.text();
        if (health.status !== 200 || healthText !== "ok") {
          failures.push(`/api/health returned ${health.status} ${JSON.stringify(healthText)}`);
        }

        const awaited = await fetch(`${vite.origin}/api/oauth/await/session-1`, {
          headers: auth,
        });
        const awaitedText = await awaited.text();
        if (awaited.status !== 200 || awaitedText !== "null") {
          failures.push(
            `/api/oauth/await/session-1 returned ${awaited.status} ${JSON.stringify(awaitedText)}`,
          );
        }

        const created = await fetch(`${vite.origin}/api/policies`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            owner: "org",
            pattern: APPROVAL_TARGET_TOOL,
            action: "require_approval",
          }),
        });
        if (!created.ok) {
          failures.push(`/api/policies setup returned ${created.status} ${await created.text()}`);
        } else {
          const policy = (await created.json()) as { readonly id?: string };
          policyId = typeof policy.id === "string" ? policy.id : null;

          const mcp = new Client(
            { name: `vite-routing-${randomBytes(3).toString("hex")}`, version: "1.0.0" },
            { capabilities: {} },
          );
          const transport = new StreamableHTTPClientTransport(
            new URL(`${vite.origin}/mcp?elicitation_mode=browser`),
            { requestInit: { headers: auth } },
          );
          await mcp.connect(transport);
          try {
            const executed = await mcp.callTool({
              name: "execute",
              arguments: { code: EXECUTE_CODE },
            });
            const paused = executed.structuredContent as {
              readonly status?: string;
              readonly executionId?: string;
              readonly approvalUrl?: string;
            };
            if (
              paused.status !== "user_approval_required" ||
              typeof paused.executionId !== "string" ||
              typeof paused.approvalUrl !== "string"
            ) {
              failures.push(
                `MCP setup did not produce a browser approval: ${JSON.stringify(paused)}`,
              );
            } else {
              const approvalUrl = new URL(paused.approvalUrl);
              const sessionId = approvalUrl.searchParams.get("mcp_session_id");
              if (!sessionId) {
                failures.push(`approval URL had no mcp_session_id: ${paused.approvalUrl}`);
              } else {
                const detail = await fetch(
                  `${vite.origin}/api/mcp-sessions/${encodeURIComponent(
                    sessionId,
                  )}/executions/${encodeURIComponent(paused.executionId)}`,
                  { headers: auth },
                );
                if (detail.status !== 200) {
                  failures.push(
                    `/api/mcp-sessions paused-detail returned ${detail.status} ${await detail.text()}`,
                  );
                }
              }
            }
          } finally {
            await mcp.close();
          }
        }
      } finally {
        if (policyId) {
          await fetch(`${vite.origin}/api/policies/${encodeURIComponent(policyId)}`, {
            method: "DELETE",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ owner: "org" }),
          }).catch(() => {});
        }
        await vite.stop();
      }

      expect(
        failures,
        "plain apps/local Vite dev should special-case the same local-only routes as production",
      ).toEqual([]);
    });
  }),
);
