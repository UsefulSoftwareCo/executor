import { describe, expect, it } from "@effect/vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import { createMcpRequestHandler } from "./mcp";

const engine: ExecutionEngine = {
  execute: (code) => Effect.succeed({ result: `ran: ${code}` }),
  executeWithPause: (code) =>
    Effect.succeed({ status: "completed", result: { result: `ran: ${code}` } }),
  resume: () => Effect.succeed(null),
  isExecutionSettled: () => Effect.succeed(false),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("local modern MCP test executor"),
};

describe("local modern MCP HTTP", () => {
  it("discovers, lists tools, and executes without creating a legacy session", async () => {
    const mcp = createMcpRequestHandler({ engine });
    const sessionHeaders: Array<string | null> = [];
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
        const response = await mcp.handleRequest(request);
        sessionHeaders.push(response.headers.get("mcp-session-id"));
        return response;
      },
    });
    const client = new Client(
      { name: "local-modern-test", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    await client.connect(transport);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close the client and local handler
    try {
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain("execute");
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "2 + 2" },
      });
      expect(result.content).toEqual([{ type: "text", text: "ran: 2 + 2" }]);
      expect(sessionHeaders.every((sessionId) => sessionId === null)).toBe(true);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
