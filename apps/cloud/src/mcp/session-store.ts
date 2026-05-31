// ---------------------------------------------------------------------------
// Cloud McpSessionStore — the shared Durable-Object dispatcher
// (@executor-js/cloudflare) over cloud's `env.MCP_SESSION` namespace. Cloud
// supplies only the stub accessors + the Sentry capture for internal errors;
// all dispatch/identity/trace/peek logic is in the shared package, identical to
// host-cloudflare.
// ---------------------------------------------------------------------------

import * as Sentry from "@sentry/cloudflare";
import { env } from "cloudflare:workers";
import { Data } from "effect";

import {
  makeDurableObjectMcpSessionStore,
  type McpSessionDOStub,
} from "@executor-js/cloudflare/mcp/session-store";

// Cloud's Sentry capture for a JSON-RPC internal (-32603) error the response
// peeker surfaces — injected into the shared store.
class McpInternalJsonRpcError extends Data.TaggedError("McpInternalJsonRpcError")<{
  readonly message: string;
}> {}

export const cloudMcpSessionStoreLayer = makeDurableObjectMcpSessionStore({
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the DO RPC stub structurally satisfies McpSessionDOStub
  getStub: (sessionId) =>
    env.MCP_SESSION.get(env.MCP_SESSION.idFromString(sessionId)) as unknown as McpSessionDOStub,
  // oxlint-disable-next-line executor/no-double-cast -- boundary: the DO RPC stub structurally satisfies McpSessionDOStub
  newStub: () => env.MCP_SESSION.get(env.MCP_SESSION.newUniqueId()) as unknown as McpSessionDOStub,
  onInternalError: (message) => Sentry.captureException(new McpInternalJsonRpcError({ message })),
});
