import { describe, expect, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  observeToolUsageServer,
  observeToolUsageTransport,
  USAGE_EXECUTE_MAX_TARGETS,
  usageExecuteTargets,
  usageTarget,
  usageStatus,
} from "./tool-usage";
import type { ToolUsageEvent } from "./tool-usage-store";

const memberHash = "b".repeat(64);

describe("tool usage MCP boundary", () => {
  it("counts real SDK calls, validation failures and denials without changing results", async () => {
    const server = new McpServer({ name: "usage-test", version: "1" });
    const events: ToolUsageEvent[] = [];
    observeToolUsageServer(server, memberHash, (event) => events.push(event));
    const ok = { content: [{ type: "text" as const, text: "result-secret" }] };
    server.registerTool("search", { inputSchema: CallToolRequestSchema }, () => ok);
    server.registerTool("invoke", {}, () => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "Tool not found or blocked by policy. Search for an available tool.",
        },
      ],
    }));
    server.registerTool("integrations", {}, () => ok);
    server.registerTool("skills", {}, () => ok);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "client-secret", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    const reply = await client.callTool({
      name: "search",
      arguments: { method: "tools/call", params: { name: "argument-secret" } },
    });
    expect(reply).toEqual(ok);
    await client.callTool({
      name: "search",
      arguments: { method: "tools/call", params: { name: "argument-secret" } },
    });
    const invalid = await client.callTool({ name: "search", arguments: { method: 7 } });
    expect(invalid.isError).toBe(true);
    await client.callTool({
      name: "invoke",
      arguments: { tool: "tools.sample.org.test.read", arguments: { secret: "invoke-secret" } },
    });
    await client.callTool({ name: "integrations" });
    await client.callTool({ name: "skills" });
    await client.close();
    await server.close();
    expect(events.map((event) => event.status)).toEqual([
      "ok",
      "ok",
      "error",
      "blocked",
      "ok",
      "ok",
    ]);
    expect(events[3]).toMatchObject({
      targetTool: "tools.sample.org.test.read",
      integrationSlug: "sample",
      memberHash,
    });
    expect(events.every((event) => event.responseBytes > 0 && event.durationMs >= 0)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(
      /argument-secret|result-secret|invoke-secret|client-secret/,
    );
  });

  it("keeps concurrent IDs separate, classifies traffic and counts abandoned calls", async () => {
    const events: ToolUsageEvent[] = [];
    const transport: Transport = {
      start: async () => {},
      close: async () => {},
      send: async () => {},
    };
    observeToolUsageTransport(transport, memberHash, (event) => events.push(event));
    await transport.start();
    const request = (id: number): JSONRPCMessage => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "skills", arguments: { name: "payload-secret" } },
    });
    transport.onmessage!(request(1), {
      requestInfo: {
        headers: { "x-executor-traffic-class": "benchmark", authorization: "bearer-secret" },
      },
    });
    transport.onmessage!(request(2));
    transport.onmessage!(request(3));
    await transport.send({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "é" }] },
    });
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "error-secret" },
    });
    transport.onclose!();
    expect(events.map((event) => [event.trafficClass, event.status])).toEqual([
      ["agent", "ok"],
      ["benchmark", "error"],
      ["agent", "error"],
    ]);
    expect(events[0]!.responseBytes).toBe(
      Buffer.byteLength(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "é" }] },
        }),
      ),
    );
    expect(events[2]!.responseBytes).toBe(0);
    expect(JSON.stringify(events)).not.toMatch(/payload-secret|bearer-secret|error-secret/);
  });

  it("preserves transport send failures and records an error", async () => {
    const events: ToolUsageEvent[] = [];
    // oxlint-disable-next-line executor/no-error-constructor -- boundary: test the SDK transport rejection contract
    const failure = new TypeError("send failed");
    const transport: Transport = {
      start: async () => {},
      close: async () => {},
      // oxlint-disable-next-line executor/no-promise-reject -- boundary: simulate a rejected native SDK send
      send: () => Promise.reject(failure),
    };
    observeToolUsageTransport(transport, memberHash, (event) => events.push(event));
    await transport.start();
    transport.onmessage!({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "search" },
    });
    await expect(transport.send({ jsonrpc: "2.0", id: 1, result: { content: [] } })).rejects.toBe(
      failure,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("error");
  });

  it("counts active observation overflow as loss and recognizes policy error codes", async () => {
    let lost = 0;
    const events: ToolUsageEvent[] = [];
    const transport: Transport = {
      start: async () => {},
      close: async () => {},
      send: async () => {},
    };
    observeToolUsageTransport(
      transport,
      memberHash,
      (event) => events.push(event),
      () => {
        lost++;
      },
    );
    await transport.start();
    for (let id = 0; id < 1025; id++) {
      transport.onmessage!({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "skills" },
      });
    }
    for (let id = 0; id < 1025; id++)
      await transport.send({ jsonrpc: "2.0", id, result: { content: [] } });
    expect(lost).toBe(1);
    expect(events).toHaveLength(1024);
    expect(events.every((event) => event.status === "ok")).toBe(true);
    expect(
      usageStatus({
        jsonrpc: "2.0",
        id: 1,
        result: {
          isError: true,
          structuredContent: { error: { code: "tool_blocked", message: "error-secret" } },
        },
      }),
    ).toBe("blocked");
  });

  it("records one execute event per distinct connected tool, or one without a target", async () => {
    const events: ToolUsageEvent[] = [];
    const transport: Transport = {
      start: async () => {},
      close: async () => {},
      send: async () => {},
    };
    observeToolUsageTransport(transport, memberHash, (event) => events.push(event));
    await transport.start();
    const request = (id: number): JSONRPCMessage => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "execute", arguments: { code: "code-secret" } },
    });
    transport.onmessage!(request(1));
    transport.onmessage!(request(2));
    transport.onmessage!(request(3));
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "result-secret" }],
        structuredContent: {
          status: "completed",
          result: "result-secret",
          toolPaths: [
            "sample.org.test.read",
            "tools.other.user.mine.write",
            "sample.org.test.read",
            "bearer secret@example.test",
            7,
          ],
          logs: ["log-secret"],
        },
      },
    });
    await transport.send({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [], structuredContent: { status: "completed", result: 42, logs: [] } },
    });
    await transport.send({
      jsonrpc: "2.0",
      id: 3,
      result: {
        isError: true,
        content: [{ type: "text", text: "Error: error-secret" }],
        structuredContent: { status: "error", error: "error-secret", logs: [] },
      },
    });
    expect(
      events.map((event) => [event.mcpTool, event.targetTool, event.integrationSlug, event.status]),
    ).toEqual([
      ["execute", "tools.sample.org.test.read", "sample", "ok"],
      ["execute", "tools.other.user.mine.write", "other", "ok"],
      ["execute", null, null, "ok"],
      ["execute", null, null, "error"],
    ]);
    expect(events[0]!.durationMs).toBe(events[1]!.durationMs);
    expect(events[0]!.responseBytes).toBe(events[1]!.responseBytes);
    expect(events[0]!.responseBytes).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/code-secret|result-secret|log-secret|error-secret/);
  });

  it("caps execute targets and ignores unexpected shapes", () => {
    const many = Array.from(
      { length: USAGE_EXECUTE_MAX_TARGETS + 5 },
      (_, index) => `sample.org.test.read${index}`,
    );
    expect(
      usageExecuteTargets({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [], structuredContent: { toolPaths: many } },
      }),
    ).toHaveLength(USAGE_EXECUTE_MAX_TARGETS);
    expect(
      usageExecuteTargets({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [], structuredContent: { toolPaths: "sample.org.test.read" } },
      }),
    ).toEqual([]);
    expect(
      usageExecuteTargets({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "x" } }),
    ).toEqual([]);
  });

  it("reduces mixed outcomes per path, validates shapes and still updates targets after the cap", () => {
    const targets = usageExecuteTargets({
      jsonrpc: "2.0",
      id: 1,
      result: {
        structuredContent: {
          toolCalls: [
            null,
            7,
            "secret",
            {},
            { path: "sample.org.test.bad", status: "error-secret" },
            { path: "secret@example.test", status: "error" },
            { path: "sample.org.test." + "x".repeat(512), status: "ok" },
            ...Array.from({ length: 35 }, (_, index) => ({
              path: `sample.org.test.read${index}`,
              status: "ok",
              args: "argument-secret",
              result: "result-secret",
            })),
            { path: "tools.sample.org.test.read0", status: "error" },
            { path: "sample.org.test.read0", status: "blocked" },
            { path: "sample.org.test.read0", status: "ok" },
            { path: "sample.org.test.read1", status: "error" },
          ],
          toolPaths: ["sample.org.test.read0"],
        },
      },
    });
    expect(targets).toHaveLength(32);
    expect(targets[0]).toEqual({
      targetTool: "tools.sample.org.test.read0",
      integrationSlug: "sample",
      status: "blocked",
    });
    expect(targets[1]!.status).toBe("error");
    expect(targets[31]!.targetTool).toBe("tools.sample.org.test.read31");
    expect(JSON.stringify(targets)).not.toMatch(/secret|args|result/);
    for (const toolCalls of [
      null,
      3,
      "secret",
      {},
      [null, { path: "sample.org.test.read", status: "constructor" }],
    ]) {
      expect(
        usageExecuteTargets({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { toolCalls } },
        }),
      ).toEqual([]);
      expect(
        usageExecuteTargets({
          jsonrpc: "2.0",
          id: 1,
          result: {
            structuredContent: {
              toolCalls,
              toolPaths: ["sample.org.test.read"],
            },
          },
        }),
      ).toEqual([{ targetTool: "tools.sample.org.test.read", integrationSlug: "sample" }]);
    }
  });

  it("records per-target failures on completed scripts and execution errors on attributed failed scripts", async () => {
    const events: ToolUsageEvent[] = [];
    const transport: Transport = {
      start: async () => {},
      close: async () => {},
      send: async () => {},
    };
    observeToolUsageTransport(transport, memberHash, (event) => events.push(event));
    await transport.start();
    const calls = [
      { path: "sample.org.test.read", status: "ok", args: "argument-secret" },
      { path: "other.user.mine.write", status: "error", error: "error-secret" },
      { path: "sample.org.test.hidden", status: "blocked", result: "result-secret" },
      { path: "sample.org.test.read", status: "error" },
    ];
    for (const id of [1, 2]) {
      transport.onmessage!({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "execute", arguments: { code: "code-secret" } },
      });
    }
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [],
        structuredContent: {
          status: "completed",
          toolCalls: calls,
          toolPaths: ["sample.org.test.read"],
          logs: ["log-secret"],
          result: "result-secret",
        },
      },
    });
    await transport.send({
      jsonrpc: "2.0",
      id: 2,
      result: {
        isError: true,
        content: [],
        structuredContent: {
          status: "error",
          toolCalls: calls,
          toolPaths: ["sample.org.test.read"],
          error: "script-secret",
        },
      },
    });
    expect(events.map(({ targetTool, status }) => [targetTool, status])).toEqual([
      ["tools.sample.org.test.read", "error"],
      ["tools.other.user.mine.write", "error"],
      ["tools.sample.org.test.hidden", "blocked"],
      ["tools.sample.org.test.read", "error"],
      ["tools.other.user.mine.write", "error"],
      ["tools.sample.org.test.hidden", "error"],
    ]);
    expect(events[0]!.durationMs).toBe(events[2]!.durationMs);
    expect(events[0]!.responseBytes).toBe(events[2]!.responseBytes);
    expect(JSON.stringify(events)).not.toMatch(/secret|args|logs|result/);
  });

  it("does not retain malformed target values", () => {
    expect(usageTarget("bearer secret@example.test")).toEqual({
      targetTool: null,
      integrationSlug: null,
    });
    expect(usageTarget({ secret: "secret" })).toEqual({ targetTool: null, integrationSlug: null });
    expect(usageTarget("tools.sample.org.test." + "x".repeat(512))).toEqual({
      targetTool: null,
      integrationSlug: null,
    });
    expect(usageTarget("sample.org.test.read")).toEqual({
      targetTool: "tools.sample.org.test.read",
      integrationSlug: "sample",
    });
  });
});
