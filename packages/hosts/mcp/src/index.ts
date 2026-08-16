// ---------------------------------------------------------------------------
// @executor-js/host-mcp — the provider-neutral MCP SERVING surface.
//
// This entry point exports ONLY the serving envelope (`McpServingRoutes`) +
// its seams (`McpAuthProvider` / `McpSessionStore` / `McpErrorReporter` /
// `Principal`) + the canonical JSON-RPC error renderer (`jsonRpcErrorBody`).
//
// The executor tool assemblies (execute/resume tools, elicitation and browser
// approval bridges, Zod input schemas) are a different center of gravity. They
// live behind the `tool-server` and `tool-server-v2` subpaths so this serving
// surface stays small and dependency-light.
// ---------------------------------------------------------------------------

export {
  Principal,
  McpAuthProvider,
  McpSessionStore,
  McpModernServerBuilder,
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
  type McpModernServerBuildOptions,
  type McpResource,
} from "./seams";

export {
  McpServingRoutes,
  McpDiscoveryRoutes,
  jsonRpcErrorBody,
  UNAVAILABLE_RETRY_AFTER_SECONDS,
} from "./envelope";
