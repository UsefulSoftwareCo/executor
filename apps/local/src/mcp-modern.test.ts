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
  it("shares a toolkit resource config across clients until handler shutdown", async () => {
    let createCalls = 0;
    let closeCalls = 0;
    const mcp = createMcpRequestHandler({
      defaultConfig: { engine },
      createConfigForResource: () => {
        createCalls += 1;
        return {
          config: { engine },
          close: async () => {
            closeCalls += 1;
          },
        };
      },
    });
    const connectClient = async () => {
      const transport = new StreamableHTTPClientTransport(
        new URL("http://local.test/mcp/toolkits/shared-toolkit"),
        {
          fetch: (input, init) =>
            mcp.handleRequest(
              input instanceof Request
                ? new Request(input, init)
                : new Request(input.toString(), init),
            ),
        },
      );
      const client = new Client(
        { name: "local-modern-toolkit-test", version: "1.0.0" },
        { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(transport);
      return client;
    };

    const first = await connectClient();
    const second = await connectClient();
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close both clients and the shared local handler
    try {
      await first.close();
      await second.close();
      expect(createCalls).toBe(1);
      expect(closeCalls).toBe(0);
    } finally {
      await first.close();
      await second.close();
      await mcp.close();
    }
    expect(closeCalls).toBe(1);
  });

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

  it("rejects a pinned modern client with the unsupported-version protocol error", async () => {
    const mcp = createMcpRequestHandler({ defaultConfig: { engine }, modernEnabled: false });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: (input, init) =>
        mcp.handleRequest(
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
        ),
    });
    const client = new Client(
      { name: "local-modern-disabled-test", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close a client whose pinned negotiation is expected to fail
    try {
      await expect(client.connect(transport)).rejects.toThrow(/version negotiation failed/i);
    } finally {
      await client.close();
      await mcp.close();
    }
  });

  it("lets an auto-mode v2 client fall back to legacy when modern inbound is disabled", async () => {
    const mcp = createMcpRequestHandler({ defaultConfig: { engine }, modernEnabled: false });
    const transport = new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), {
      fetch: (input, init) =>
        mcp.handleRequest(
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
        ),
    });
    const client = new Client(
      { name: "local-auto-fallback-test", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );

    await client.connect(transport);
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always close the fallback client and local handler
    try {
      expect(client.getProtocolEra()).toBe("legacy");
      expect((await client.listTools()).tools.map(({ name }) => name)).toContain("execute");
      const result = await client.callTool({
        name: "execute",
        arguments: { code: "3 + 4" },
      });
      expect(result.content).toEqual([{ type: "text", text: "ran: 3 + 4" }]);
      expect(transport.sessionId).toBeTruthy();
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
