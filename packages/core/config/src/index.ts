export {
  ExecutorFileConfig,
  PluginConfig,
  IntegrationConfig,
  OpenApiIntegrationConfig,
  GraphqlIntegrationConfig,
  McpRemoteIntegrationConfig,
  McpStdioIntegrationConfig,
  McpAuthConfig,
  SecretMetadata,
  ConfigHeaderValue,
  SECRET_REF_PREFIX,
} from "./schema";

export { loadConfig, ConfigParseError } from "./load";
export { loadPluginsFromJsonc } from "./load-plugins";
export type { LoadPluginsFromJsoncOptions } from "./load-plugins";

export {
  addIntegrationToConfig,
  removeIntegrationFromConfig,
  writeConfig,
  addSecretToConfig,
  removeSecretFromConfig,
} from "./write";

export type { ConfigFileSink, ConfigFileSinkOptions } from "./sink";
export { makeFileConfigSink, headerToConfigValue, headersToConfigValues } from "./sink";
