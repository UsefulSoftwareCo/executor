// ---------------------------------------------------------------------------
// Quiet standalone GET `/mcp` under Bun — regression for #1983
// ---------------------------------------------------------------------------
//
// After initialize, the SDK GET stream is a 200 `text/event-stream` with no
// body bytes until a server-initiated message. Bun fetch does not settle a
// silent stream even when `Bun.serve` has `idleTimeout: 0`. The handler must
// emit a legal SSE comment so the GET resolves promptly, then drop the
// upstream stream on cancel so a reconnect is not 409.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import { createMcpRequestHandler } from "./mcp";

const MCP_POST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

const stubEngine: ExecutionEngine<never> = {
  execute: () => Effect.succeed({ result: "unused" }),
  executeWithPause: () => Effect.succeed({ status: "completed", result: { result: "unused" } }),
  resume: () => Effect.succeed(null),
  getPausedExecution: () => Effect.succeed(null),
  pausedExecutionCount: () => Effect.succeed(0),
  hasPausedExecutions: () => Effect.succeed(false),
  getDescription: Effect.succeed("test executor"),
  shutdown: Effect.void,
};

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bun-sse-test", version: "1.0.0" },
  },
};

const openLiveSession = async (
  origin: string,
  path = "/mcp",
): Promise<{ readonly sessionId: string }> => {
  const init = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: MCP_POST_HEADERS,
    body: JSON.stringify(initializeBody),
  });
  expect(init.status).toBe(200);
  const sessionId = init.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  await init.body?.cancel();

  const initialized = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { ...MCP_POST_HEADERS, "mcp-session-id": sessionId! },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  expect(initialized.status).toBe(202);
  await initialized.body?.cancel();
  return { sessionId: sessionId! };
};

describe("local MCP handler, quiet GET stream", () => {
  it("resolves a live-session GET under Bun with a keepalive comment and reconnects after cancel", async () => {
    const handler = createMcpRequestHandler({ engine: stubEngine });
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (request) => handler.handleRequest(request),
    });

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always stop the server
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const { sessionId } = await openLiveSession(origin);

      const get = await fetch(`${origin}/mcp`, {
        method: "GET",
        headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
        signal: AbortSignal.timeout(1_000),
      });
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toContain("text/event-stream");
      expect(get.headers.get("mcp-session-id")).toBe(sessionId);

      const reader = get.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(": keepalive\n\n");
      await reader.cancel();

      const reconnect = await fetch(`${origin}/mcp`, {
        method: "GET",
        headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
        signal: AbortSignal.timeout(1_000),
      });
      expect(reconnect.status).toBe(200);
      expect(reconnect.headers.get("content-type")).toContain("text/event-stream");
      await reconnect.body?.cancel();
    } finally {
      server.stop(true);
      await handler.close();
    }
  });

  it("keeps the same GET contract on a toolkit MCP path", async () => {
    const handler = createMcpRequestHandler({ engine: stubEngine });
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (request) => handler.handleRequest(request),
    });

    // oxlint-disable-next-line executor/no-try-catch-or-throw -- test boundary: always stop the server
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const path = "/mcp/toolkits/deploy";
      const { sessionId } = await openLiveSession(origin, path);

      const get = await fetch(`${origin}${path}`, {
        method: "GET",
        headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
        signal: AbortSignal.timeout(1_000),
      });
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toContain("text/event-stream");
      const reader = get.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
      await reader.cancel();
    } finally {
      server.stop(true);
      await handler.close();
    }
  });
});
