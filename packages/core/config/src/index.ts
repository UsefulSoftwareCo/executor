export {
  ExecutorFileConfig,
  PluginConfig,
  SourceConfig,
  OpenApiSourceConfig,
  GraphqlSourceConfig,
  McpRemoteSourceConfig,
  McpAuthConfig,
  SecretMetadata,
  ConfigHeaderValue,
  SECRET_REF_PREFIX,
} from "./schema";

export { loadConfig, ConfigParseError } from "./load";
export { loadPluginsFromJsonc } from "./load-plugins";
export type { LoadPluginsFromJsoncOptions } from "./load-plugins";

export {
  addSourceToConfig,
  removeSourceFromConfig,
  writeConfig,
  addSecretToConfig,
  removeSecretFromConfig,
} from "./write";

export type { ConfigFileSink, ConfigFileSinkOptions } from "./sink";
export { makeFileConfigSink, headerToConfigValue, headersToConfigValues } from "./sink";
