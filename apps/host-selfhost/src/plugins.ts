// Single shared instantiation of the self-host plugin list, mirroring
// `apps/cloud/src/api/cloud-plugins.ts`. The API composition
// (`composePluginApi`/`composePluginHandlerLayer`) and the per-request
// middleware (`providePluginExtensions`, `PluginExtensionServices<...>`) all
// derive their typed views from this one tuple, so adding/removing a plugin is
// a single `executor.config.ts` edit. The per-request executor builds its own
// fresh `executor.config.ts#plugins()` instances via the `PluginsProvider` seam
// (execution.ts).
import executorConfig from "../executor.config";

export const selfHostPlugins = executorConfig.plugins();
export type SelfHostPlugins = typeof selfHostPlugins;
