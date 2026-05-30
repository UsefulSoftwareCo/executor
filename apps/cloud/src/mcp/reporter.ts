// ---------------------------------------------------------------------------
// Cloud MCP error reporter seam — `cloudMcpReporter`.
//
// Forwards a request-orchestration defect the shared host-mcp envelope is about
// to render as a JSON-RPC 500 to Sentry (`captureCause`) and the dev console,
// preserving the OLD `mcpApp`'s top-level
// `console.error('[mcp] request failed', …)` + `captureCause` behavior that the
// shared envelope would otherwise swallow (it returns a `Response`).
// ---------------------------------------------------------------------------

import { Cause, Effect, Layer } from "effect";

import { McpErrorReporter } from "@executor-js/host-mcp";

import { captureCause } from "../observability";

export const cloudMcpReporter: Layer.Layer<McpErrorReporter> = Layer.succeed(McpErrorReporter)({
  report: (cause) =>
    Effect.sync(() => {
      // oxlint-disable-next-line no-console -- boundary: preserve the old mcpApp top-level request-failure log
      console.error("[mcp] request failed:", Cause.pretty(cause));
      captureCause(cause);
    }),
});
