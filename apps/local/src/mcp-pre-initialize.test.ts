// ---------------------------------------------------------------------------
// Local app × the pre-initialize dispatch guard — through the real handler
// ---------------------------------------------------------------------------
//
// `executor mcp` bridges a stdio client to this handler's `/mcp` endpoint, so
// what the handler answers on a session-less POST decides whether the client's
// connection survives its first probe:
//
//   test → createMcpRequestHandler().handleRequest(Request)
//        → pre-initialize guard  (an unknown method -> -32601 on a 200)
//        → WebStandardStreamableHTTPServerTransport (everything else)
//
// The guard replaces exactly ONE transport answer — the connection-killing
// `400 -32000 Server not initialized` for a method that is not `initialize`.
// These assert that replacement AND that no other transport answer is shadowed:
// a request that fails content negotiation still gets the transport's 415/406,
// and a structurally invalid JSON-RPC message still gets its parse error, not a
// "method not found" that was never true.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ExecutionEngine } from "@executor-js/execution";

import { createMcpRequestHandler } from "./mcp";

/** The headers a streamable-HTTP client must send on a POST; less is a 406/415. */
const MCP_POST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const;

/** No code ever runs here: these requests are answered before any tool call. */
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

const post = (
  body: unknown,
  headers: Record<string, string> = MCP_POST_HEADERS,
): Promise<Response> =>
  createMcpRequestHandler({ engine: stubEngine }).handleRequest(
    new Request("http://local.test/mcp", { method: "POST", headers, body: JSON.stringify(body) }),
  );

interface JsonRpcErrorBody {
  readonly error: { readonly code: number; readonly message: string };
}

describe("local MCP handler, pre-initialize", () => {
  it("answers a valid unknown pre-session method with -32601 on a 200", async () => {
    const response = await post({ jsonrpc: "2.0", id: 7, method: "server/discover", params: {} });

    // 200, not the transport's 400: a per-request error the bridged client
    // survives, so it can still fall back to `initialize`.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("passes a pre-session notification to the transport", async () => {
    const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });

    // A notification carries no id, so the guard may not answer it at all;
    // whatever comes back is the transport's own answer.
    const body = (await response.json()) as JsonRpcErrorBody;
    expect(body.error.code).not.toBe(-32601);
    expect(body.error.code).toBe(-32000);
  });

  it("leaves a structurally invalid request to the transport's parse error", async () => {
    // A fractional id is not a JSON-RPC id, so this is not a request the guard
    // may report an unknown method for.
    const response = await post({ jsonrpc: "2.0", id: 1.5, method: "server/discover" });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonRpcErrorBody;
    expect(body.error.code).toBe(-32700);
    expect(body.error.code).not.toBe(-32601);
  });

  it("leaves a wrong Content-Type to the transport's 415", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "server/discover" },
      { "content-type": "text/plain", accept: MCP_POST_HEADERS.accept },
    );

    expect(response.status).toBe(415);
  });

  it("leaves an incomplete Accept to the transport's 406", async () => {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "server/discover" },
      { "content-type": "application/json", accept: "application/json" },
    );

    expect(response.status).toBe(406);
  });
});
