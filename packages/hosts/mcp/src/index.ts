// ---------------------------------------------------------------------------
// @executor-js/host-mcp — the provider-neutral MCP SERVING surface.
//
// This entry point exports ONLY the serving envelope (`McpServingRoutes`) +
// its seams (`McpAuthProvider` / `McpSessionStore` / `McpErrorReporter` /
// `Principal`) + the canonical JSON-RPC error renderer (`jsonRpcErrorBody`).
//
// The executor TOOL factory (`createExecutorMcpServer` — the execute/resume
// tools, the elicitation/browser-approval bridge, the Zod input schemas) is a
// different center of gravity: a host's session store builds an `McpServer`
// from it. It lives behind the `@executor-js/host-mcp/tool-server` subpath so
// the serving surface stays small and dependency-light.
// ---------------------------------------------------------------------------

export {
  Principal,
  McpAuthProvider,
  McpSessionStore,
  McpErrorReporter,
  McpErrorReporterNoop,
  defaultMcpResource,
  mcpResourceKey,
  principalOwns,
  authenticated,
  unauthorized,
  forbidden,
  unavailable,
  type AuthOutcome,
  type McpAuthenticated,
  type McpUnauthorized,
  type McpForbidden,
  type McpUnavailable,
  type McpDiscoveryRoute,
  type McpDispatchInput,
  type McpDispatchResult,
  type McpResource,
} from "./seams";

export { McpServingRoutes, McpDiscoveryRoutes, jsonRpcErrorBody } from "./envelope";
