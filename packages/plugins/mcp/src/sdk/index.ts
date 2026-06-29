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

export { migrateMcpAuthConfig } from "./migrate-config";

// Request-shaped authoring: `headers: { Authorization: ["Bearer ", variable("token")] }`.
export { variable, type ApiKeyAuthTemplate } from "@executor-js/sdk/http-auth";

// Only the API-facing errors; the internal Data.TaggedError ones stay private.
export { McpConnectionError, McpToolDiscoveryError, McpOAuthError } from "./errors";

export { deriveMcpNamespace, joinToolPath, extractManifestFromListToolsResult } from "./manifest";
