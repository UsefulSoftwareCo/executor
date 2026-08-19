import { describe, expect, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const cliEntry = resolve(repoRoot, "apps/cli/src/main.ts");
const testScope = resolve(repoRoot, "apps/local");

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
});
