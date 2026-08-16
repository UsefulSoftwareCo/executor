import { describe, expect, it } from "@effect/vitest";
import { Client as ModernClient } from "@modelcontextprotocol/client";
import { StdioClientTransport as ModernStdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
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

describe("MCP stdio integration", () => {
  it.effect(
    "execute tool returns result over the CLI stdio bridge",
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
    "serves a modern-pinned client over the same v2 stdio entry",
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
