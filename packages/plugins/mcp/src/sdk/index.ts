export {
  mcpPlugin,
  type McpPluginExtension,
  type McpPluginOptions,
  type McpSourceConfig,
  type McpRemoteSourceConfig,
  type McpStdioSourceConfig,
  type McpProbeResult,
  type McpConfigureSourceInput,
} from "./plugin";

export {
  makeMcpStore,
  mcpSchema,
  type McpBindingStore,
  type McpSchema,
  type McpStoredSource,
} from "./binding-store";

export {
  ConfiguredMcpCredentialValue,
  MCP_HEADER_AUTH_SLOT,
  MCP_OAUTH_CLIENT_ID_SLOT,
  MCP_OAUTH_CLIENT_SECRET_SLOT,
  MCP_OAUTH_CONNECTION_SLOT,
  McpConnectionAuth,
  McpConnectionAuthInput,
  McpCredentialInput,
  mcpHeaderSlot,
  mcpQueryParamSlot,
} from "./types";
