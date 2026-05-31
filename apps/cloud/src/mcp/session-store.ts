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

// The DO RPC stub structurally satisfies `McpSessionDOStub` (init/handleRequest/
// clearSession), but `@cloudflare/workers-types` types it as a generic
// `DurableObjectStub`. Narrow at this one boundary via an `unknown` hop — a
// single cast, so no double-cast through the worker-types stub type.
const toSessionStub = (stub: unknown): McpSessionDOStub => stub as McpSessionDOStub;

export const cloudMcpSessionStoreLayer = makeDurableObjectMcpSessionStore({
  getStub: (sessionId) =>
    toSessionStub(env.MCP_SESSION.get(env.MCP_SESSION.idFromString(sessionId))),
  newStub: () => toSessionStub(env.MCP_SESSION.get(env.MCP_SESSION.newUniqueId())),
  onInternalError: (message) => Sentry.captureException(new McpInternalJsonRpcError({ message })),
});
