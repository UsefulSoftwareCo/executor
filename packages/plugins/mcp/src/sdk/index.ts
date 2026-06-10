export {
  mcpPlugin,
  userFacingProbeMessage,
  type McpPluginExtension,
  type McpPluginOptions,
  type McpServerInput,
  type McpRemoteServerInput,
  type McpStdioServerInput,
  type McpProbeResult,
  type McpProbeEndpointInput,
  type McpExtensionFailure,
} from "./plugin";

export {
  McpAuthMethod,
  McpAuthMethodInput,
  McpAuthShorthand,
  McpIntegrationConfig,
  McpRemoteIntegrationConfig,
  McpStdioIntegrationConfig,
  McpRemoteTransport,
  McpTransport,
  McpToolAnnotations,
  McpToolBinding,
  parseMcpIntegrationConfig,
} from "./types";

export {
  McpConnectionError,
  McpToolDiscoveryError,
  McpInvocationError,
  McpOAuthError,
} from "./errors";

export { deriveMcpNamespace, joinToolPath, extractManifestFromListToolsResult } from "./manifest";
