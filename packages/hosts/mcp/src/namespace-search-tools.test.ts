import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type * as Cause from "effect/Cause";

import type { ExecutionEngine } from "@executor-js/execution";

import { readSearchToolsEnabled } from "./browser-approval";
import { createExecutorMcpServer, type ExecutorMcpServerConfig } from "./tool-server";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A stub engine that records every executed code string, so a test can prove
 *  a `search_<integration>` call became the expected `tools.search` code. */
const makeRecordingEngine = (): {
  engine: ExecutionEngine;
  executed: string[];
} => {
  const executed: string[] = [];
  return {
    executed,
    engine: {
      execute: () => Effect.succeed({ result: "default" }),
      executeWithPause: (code) =>
        Effect.sync(() => {
          executed.push(code);
          return { status: "completed" as const, result: { result: "default" } };
        }),
      resume: () => Effect.succeed(null),
      isExecutionSettled: undefined,
      getPausedExecution: () => Effect.succeed(null),
      pausedExecutionCount: () => Effect.succeed(0),
      hasPausedExecutions: () => Effect.succeed(false),
      getDescription: Effect.succeed("test executor"),
    },
  };
};

// The inventory block exactly as `buildExecuteDescription` renders it,
// including an overflow marker and a slug that cannot form a legal MCP tool
// name (which registration must skip, not fail on).
const DESCRIPTION_WITH_INVENTORY = [
  "Execute TypeScript in a sandboxed runtime.",
  "",
  "## Available integrations",
  "",
  "Integrations you have connected. Their tools live under `tools.<integration>.…`.",
  "- `github`",
  "- `google_gmail`",
  "- `not a tool name!`",
  "- ... 3 more",
].join("\n");

const DESCRIPTION_WITHOUT_INVENTORY = "Execute TypeScript in a sandboxed runtime.";

const withClient = async <E extends Cause.YieldableError>(
  config: ExecutorMcpServerConfig<E>,
  fn: (client: Client) => Promise<void>,
) => {
  const mcpServer = await Effect.runPromise(createExecutorMcpServer(config));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test helper must close MCP transports after async client assertions
  try {
    await fn(client);
  } finally {
    await clientTransport.close();
    await serverTransport.close();
  }
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((tool) => tool.name);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("MCP host — per-integration search tools", () => {
  it("registers none by default: the option is opt-in", async () => {
    const { engine } = makeRecordingEngine();
    await withClient({ engine, description: DESCRIPTION_WITH_INVENTORY }, async (client) => {
      const names = await toolNames(client);
      expect(names).toContain("execute");
      expect(names.filter((name) => name.startsWith("search_"))).toEqual([]);
    });
  });

  it("registers none when the flag is explicitly false", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      { engine, description: DESCRIPTION_WITH_INVENTORY, searchToolsEnabled: false },
      async (client) => {
        expect((await toolNames(client)).filter((name) => name.startsWith("search_"))).toEqual([]);
      },
    );
  });

  it("registers one search_<integration> tool per inventory entry when opted in", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      { engine, description: DESCRIPTION_WITH_INVENTORY, searchToolsEnabled: true },
      async (client) => {
        const tools = (await client.listTools()).tools;
        const names = tools.map((tool) => tool.name);
        expect(names).toContain("search_github");
        expect(names).toContain("search_google_gmail");
        // The core surface is untouched.
        expect(names).toContain("execute");
        expect(names).toContain("skills");
        // The overflow marker is not an integration, and a slug that cannot
        // form a legal MCP tool name is skipped rather than failing the
        // session.
        expect(names.filter((name) => name.startsWith("search_"))).toHaveLength(2);

        // Minimal descriptions: one line that names the namespace and points
        // back at the execute flow.
        const gmail = tools.find((tool) => tool.name === "search_google_gmail");
        expect(gmail?.description).toContain("google_gmail");
        expect(gmail?.description).toContain("execute");
        expect(gmail?.description?.includes("\n")).toBe(false);
      },
    );
  });

  it("registers none when the description carries no inventory", async () => {
    const { engine } = makeRecordingEngine();
    await withClient(
      { engine, description: DESCRIPTION_WITHOUT_INVENTORY, searchToolsEnabled: true },
      async (client) => {
        expect((await toolNames(client)).filter((name) => name.startsWith("search_"))).toEqual([]);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Dispatch: the call is the same flow as `tools.search` inside execute
  // ---------------------------------------------------------------------------

  it("routes a call through the engine as tools.search with the namespace pinned", async () => {
    const { engine, executed } = makeRecordingEngine();
    await withClient(
      { engine, description: DESCRIPTION_WITH_INVENTORY, searchToolsEnabled: true },
      async (client) => {
        const result = await client.callTool({
          name: "search_github",
          arguments: { query: "issues", limit: 5 },
        });
        expect(executed).toEqual([
          'return tools.search({"query":"issues","namespace":"github","limit":5})',
        ]);
        expect(result.isError ?? false).toBe(false);
      },
    );
  });

  it("enumerates the namespace when the query is omitted", async () => {
    const { engine, executed } = makeRecordingEngine();
    await withClient(
      { engine, description: DESCRIPTION_WITH_INVENTORY, searchToolsEnabled: true },
      async (client) => {
        await client.callTool({ name: "search_google_gmail", arguments: {} });
        expect(executed).toEqual(['return tools.search({"query":"","namespace":"google_gmail"})']);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Endpoint query contract
// ---------------------------------------------------------------------------

describe("search tools opt-in query", () => {
  const requestFor = (url: string): Request => new Request(url);

  it("defaults to disabled on a clean endpoint", () => {
    expect(readSearchToolsEnabled(requestFor("https://executor.example/mcp"))).toBe(false);
  });

  it("accepts the truthy spellings", () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", "On"]) {
      expect(
        readSearchToolsEnabled(requestFor(`https://executor.example/mcp?search_tools=${value}`)),
      ).toBe(true);
    }
  });

  it("reads any other explicit value as the default (disabled)", () => {
    for (const value of ["false", "0", "no", "off", "maybe", ""]) {
      expect(
        readSearchToolsEnabled(requestFor(`https://executor.example/mcp?search_tools=${value}`)),
      ).toBe(false);
    }
  });
});
