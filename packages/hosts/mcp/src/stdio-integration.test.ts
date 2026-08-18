import { describe, expect, it } from "@effect/vitest";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Schema } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliEntry = resolve(repoRoot, "apps/cli/src/main.ts");
const testScope = resolve(repoRoot, "apps/local");
const stdioServerEntry = resolve(repoRoot, "apps/local/src/mcp-stdio-test-server.ts");
const stdioServer = {
  command: "bun",
  args: ["run", stdioServerEntry],
};
const decodeDaemonManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Number })),
);

const isProcessGroupAlive = (pid: number): boolean => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: process liveness probing reports false after the test daemon is reaped
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signalProcessGroup = (pid: number, signal: NodeJS.Signals): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Windows and pre-detach failures require a direct-pid fallback
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- cleanup tolerates a daemon that exited between liveness check and signal
    try {
      process.kill(pid, signal);
    } catch {}
  }
};

const stopAutoSpawnedDaemon = async (dataDir: string): Promise<void> => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- cleanup tolerates startup that failed before publishing a manifest
  try {
    const manifest = decodeDaemonManifest(
      readFileSync(join(dataDir, "server-control", "server.json"), "utf8"),
    );
    if (!Number.isSafeInteger(manifest.pid) || manifest.pid <= 0) return;

    const pid = manifest.pid;
    signalProcessGroup(pid, "SIGTERM");
    const deadline = performance.now() + 10_000;
    while (isProcessGroupAlive(pid) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (isProcessGroupAlive(pid)) signalProcessGroup(pid, "SIGKILL");
  } catch {
    // No manifest means there is no auto-started daemon to stop.
  }
};

const withTempData = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "executor-mcp-test-"))),
  (dataDir) =>
    Effect.promise(async () => {
      await stopAutoSpawnedDaemon(dataDir);
      rmSync(dataDir, { recursive: true, force: true });
    }),
);

describe("MCP stdio integration", () => {
  it.effect(
    "execute tool returns result over the CLI stdio bridge",
    () =>
      Effect.gen(function* () {
        // Fresh temp dir so the test doesn't migrate against the developer's
        // real ~/.executor/data.db.
        const dataDir = yield* withTempData;
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
        expect(tools.map(({ name }) => name)).toContain("execute");

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
    "serves a legacy client and completes the native elicitation round-trip",
    () =>
      Effect.gen(function* () {
        const transport = new StdioClientTransport(stdioServer);
        const client = new Client(
          { name: "legacy-stdio-test-client", version: "1.0.0" },
          { capabilities: { elicitation: { form: {} } } },
        );
        let elicitationRequests = 0;
        client.setRequestHandler(ElicitRequestSchema, async (request) => {
          elicitationRequests += 1;
          expect(request.params).toMatchObject({ message: "Approve the stdio action?" });
          return { action: "accept" as const, content: { value: "approved" } };
        });

        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(transport)),
          () => Effect.promise(() => transport.close()),
        );

        const { tools } = yield* Effect.promise(() => client.listTools());
        expect(tools.map((t) => t.name)).toContain("execute");

        const result = yield* Effect.promise(() =>
          client.callTool({
            name: "execute",
            arguments: { code: "needs approval" },
          }),
        );

        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        expect(text).toContain("approved");
        expect(result.isError).toBeFalsy();
        expect(elicitationRequests).toBe(1);
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it.effect(
    "serves a modern-pinned client over the same stdio entry",
    () =>
      Effect.gen(function* () {
        const transport = new ModernStdioClientTransport(stdioServer);
        const client = new ModernClient(
          { name: "modern-stdio-test-client", version: "1.0.0" },
          {
            capabilities: {},
            versionNegotiation: { mode: { pin: "2026-07-28" } },
          },
        );

        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(transport)),
          () => Effect.promise(() => transport.close()),
        );

        const { tools } = yield* Effect.promise(() => client.listTools());
        expect(tools.map(({ name }) => name)).toContain("execute");

        const result = yield* Effect.promise(() =>
          client.callTool({
            name: "execute",
            arguments: { code: "return 2+2" },
          }),
        );

        expect(result.content).toEqual([{ type: "text", text: "4" }]);
        expect(result.isError).toBeFalsy();
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );
});
