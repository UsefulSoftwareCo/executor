// ---------------------------------------------------------------------------
// MCP connection pooling regression test
//
// Production telemetry (Axiom, 2026-04-30): `plugin.mcp.connection.acquire`
// p99 = 3.59s, with `plugin.mcp.connection.handshake` p99 = 3.28s firing on
// ~17% of acquires. The cold MCP handshake is the dominant tail-latency
// source for tool invocations. The MCP plugin already pools connections via
// a `ScopedCache` keyed on `${transport}:${invokerScope}:${endpoint}` (see
// `plugin.ts#makeRuntime`), so within a single executor / session DO the
// SECOND and onward invocations against the same source config MUST reuse
// the cached connection without performing a fresh transport handshake.
//
// This file pins that contract behind a deterministic test harness that
// counts inbound MCP server sessions — each MCP server `connect` is exactly
// one cold handshake on the wire. After the first invoke kicks off the cold
// connection, all subsequent calls (regardless of which tool on the source
// they target) MUST land on the same MCP session.
//
// If this test starts failing, the cache key, the runtime ref, or the
// `Effect.scoped` boundary inside `invokeMcpTool` has regressed and prod
// will see the cold-handshake p99 climb proportionally.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { createExecutor, makeTestConfig } from "@executor-js/sdk";

import { mcpPlugin } from "./plugin";

// ---------------------------------------------------------------------------
// Test MCP server — counts session connects (each = one cold handshake)
// ---------------------------------------------------------------------------

function createTestMcpServer() {
  const server = new McpServer(
    { name: "pool-test-server", version: "1.0.0" },
    { capabilities: {} },
  );

  server.registerTool(
    "echo",
    { description: "Echo a value", inputSchema: { value: z.string() } },
    async ({ value }: { value: string }) => ({
      content: [{ type: "text" as const, text: value }],
    }),
  );

  server.registerTool(
    "echo2",
    { description: "Echo a value", inputSchema: { value: z.string() } },
    async ({ value }: { value: string }) => ({
      content: [{ type: "text" as const, text: `b:${value}` }],
    }),
  );

  return server;
}

type TestServer = {
  readonly url: string;
  readonly httpServer: http.Server;
  /** Number of MCP sessions created (1 per cold transport handshake). */
  readonly sessionCount: () => number;
};

const serveMcpServer = Effect.acquireRelease(
  Effect.callback<TestServer, Error>((resume) => {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    let sessions = 0;

    const httpServer = http.createServer(async (req, res) => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(404);
          res.end("Session not found");
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      const mcpServer = createTestMcpServer();
      sessions++;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    });

    httpServer.listen(0, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resume(
        Effect.succeed({
          url: `http://127.0.0.1:${port}`,
          httpServer,
          sessionCount: () => sessions,
        }),
      );
    });
  }),
  ({ httpServer }) =>
    Effect.sync(() => {
      httpServer.close();
    }),
);

// ---------------------------------------------------------------------------
// Helper — one executor, one mcp source pointed at the test server
// ---------------------------------------------------------------------------

const makeTestExecutor = (serverUrl: string, namespace = "pool-test") =>
  createExecutor(
    makeTestConfig({
      plugins: [mcpPlugin()] as const,
    }),
  ).pipe(
    Effect.tap((executor) =>
      executor.mcp.addSource({
        transport: "remote",
        scope: "test-scope",
        name: namespace,
        namespace,
        endpoint: serverUrl,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP connection pooling (regression)", () => {
  it.effect(
    "five sequential invokes against the same source perform exactly one transport handshake",
    () =>
      Effect.gen(function* () {
        const server = yield* serveMcpServer;
        const executor = yield* makeTestExecutor(server.url);
        const tools = yield* executor.tools.list();
        const echo = tools.find((t) => t.name === "echo")!;
        expect(echo).toBeDefined();

        // Discovery during addSource performs ONE handshake on a separate,
        // closed connection — that's expected. Capture the baseline so we
        // assert against the invoke-path delta only.
        const sessionsAfterAddSource = server.sessionCount();
        expect(sessionsAfterAddSource).toBeGreaterThanOrEqual(1);

        // First invoke is necessarily a cache miss — it cold-handshakes the
        // pooled connection. Every subsequent invoke must hit the cache and
        // produce zero new MCP server sessions.
        yield* executor.tools.invoke(echo.id, { value: "1" }, { onElicitation: "accept-all" });
        const sessionsAfterFirstInvoke = server.sessionCount();
        expect(sessionsAfterFirstInvoke).toBe(sessionsAfterAddSource + 1);

        for (let i = 2; i <= 5; i++) {
          yield* executor.tools.invoke(
            echo.id,
            { value: String(i) },
            { onElicitation: "accept-all" },
          );
          // Cache must reuse the same MCP session for every subsequent
          // call. If this assertion fails the session DO is paying the
          // cold-handshake p99 (3.28s in prod) on every tool call.
          expect(server.sessionCount()).toBe(sessionsAfterFirstInvoke);
        }
      }),
  );

  it.effect("different tools on the same source share the cached connection", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const executor = yield* makeTestExecutor(server.url);
      const tools = yield* executor.tools.list();
      const echo = tools.find((t) => t.name === "echo")!;
      const echo2 = tools.find((t) => t.name === "echo2")!;
      expect(echo).toBeDefined();
      expect(echo2).toBeDefined();

      const sessionsAfterAddSource = server.sessionCount();

      // Cold handshake on first call.
      yield* executor.tools.invoke(echo.id, { value: "a" }, { onElicitation: "accept-all" });
      const baseline = server.sessionCount();
      expect(baseline).toBe(sessionsAfterAddSource + 1);

      // Different tool on the SAME source — same cache key, same conn.
      yield* executor.tools.invoke(echo2.id, { value: "b" }, { onElicitation: "accept-all" });
      expect(server.sessionCount()).toBe(baseline);

      // Back to the first tool — still pooled.
      yield* executor.tools.invoke(echo.id, { value: "c" }, { onElicitation: "accept-all" });
      expect(server.sessionCount()).toBe(baseline);
    }),
  );

  it.effect("different sources with the same endpoint use separate cached connections", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer;
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [mcpPlugin()] as const,
        }),
      );
      yield* executor.mcp.addSource({
        transport: "remote",
        scope: "test-scope",
        name: "pool-a",
        namespace: "pool_a",
        endpoint: server.url,
      });
      yield* executor.mcp.addSource({
        transport: "remote",
        scope: "test-scope",
        name: "pool-b",
        namespace: "pool_b",
        endpoint: server.url,
      });

      const tools = yield* executor.tools.list();
      const echoTools = tools.filter((t) => t.name === "echo");
      expect(echoTools).toHaveLength(2);

      const sessionsAfterAddSource = server.sessionCount();

      yield* executor.tools.invoke(
        echoTools[0]!.id,
        { value: "a" },
        { onElicitation: "accept-all" },
      );
      const afterFirstInvoke = server.sessionCount();
      expect(afterFirstInvoke).toBe(sessionsAfterAddSource + 1);

      yield* executor.tools.invoke(
        echoTools[1]!.id,
        { value: "b" },
        { onElicitation: "accept-all" },
      );
      expect(server.sessionCount()).toBe(afterFirstInvoke + 1);
    }),
  );
});
