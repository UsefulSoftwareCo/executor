/** Native Effect MCP protocol sessions; product data and grants stay in Postgres. */
import { traceHeaders } from "@executor-js/telemetry";
import { authenticatedMcp, browserMcpRequest, mcpSessionKey } from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import { forwardMcpRequest } from "../implementation/mcp-forward.ts";
import { timedForward } from "../implementation/mcp-session-timing.ts";
import { observeMcpStream } from "../implementation/mcp-stream-observability.ts";
import type { McpSessionObject } from "./mcp-session.ts";
import { McpServer } from "./mcp-server-worker.ts";

/**
 * The gateway selects one private object per authenticated user/client/organization. The MCP
 * server Worker hosts them, so a wake never starts the API Worker. Objects keep no storage: an
 * MCP session lives in the object's memory until it is evicted.
 */
export class McpSession extends Cloudflare.DurableObject<McpSession, McpSessionObject>()(
  "McpSession",
) {}

/** Resolve the session binding at startup; return a handler authenticated on each request. */
export const cloudMcp = Effect.gen(function* () {
  const sessions = yield* McpSession.from(McpServer);
  const forward = (access: Parameters<typeof mcpSessionKey>[0]) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("executor.organization.id", access.access.organization);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const headers = yield* traceHeaders;
      const traced = request.modify({ headers: { ...request.headers, ...headers } });
      return yield* forwardMcpRequest(traced, (attempt) =>
        timedForward(sessions.getByName(mcpSessionKey(access)).fetch(attempt)),
      );
    }).pipe(Effect.flatMap(observeMcpStream("gateway")), Effect.withSpan("mcp.session.forward"));
  return {
    http: authenticatedMcp(forward),
    approvals: browserMcpRequest((access) => forward(access)),
  };
});
