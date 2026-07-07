// Host-facing plugin surface for @executor-js/plugin-apps.
import { definePlugin } from "@executor-js/sdk/core";

import {
  appsPlugin as appsCorePlugin,
  APPS_INTEGRATION_SLUG,
  APPS_PLUGIN_ID,
  type AppsPluginOptions,
} from "./plugin/apps-plugin";
import { AppsGroup } from "./plugin/routes";
import { AppsHandlers, AppsExtensionService } from "./plugin/handlers";

export const appsPlugin = definePlugin((options?: AppsPluginOptions) => ({
  ...appsCorePlugin(options),
  routes: () => AppsGroup,
  handlers: () => AppsHandlers,
  extensionService: AppsExtensionService,
}));

export { APPS_INTEGRATION_SLUG, APPS_PLUGIN_ID, type AppsPluginOptions };
export { AppsGroup } from "./plugin/routes";
export { AppsHandlers, AppsExtensionService } from "./plugin/handlers";
export {
  makeSelfHostAppsRuntime,
  type SelfHostAppsRuntime,
  type SelfHostAppsRuntimeOptions,
} from "./plugin/self-host-runtime";
export { type AppsRuntime, type GitHubCustomToolsSourceSummary } from "./plugin/runtime";
export { makeAppsRuntimeFromBackings, type AppsBackings } from "./plugin/backings";
export { makeGitArtifactStore } from "./backing/git-artifact-store";
export { makeLibsqlScopeDb } from "./backing/libsql-scope-db";
export { makeQuickjsToolSandbox } from "./backing/quickjs-tool-sandbox";
export { makeSqliteAppsStore } from "./backing/sqlite-apps-store";
export {
  BindingError,
  type ClientResolver,
  type ConnectionCandidate,
  type RoleBindings,
} from "./plugin/bindings";
export { makePluginCtxAppsResolver } from "./plugin/resolver";
export {
  fetchGitHubSource,
  parseGitHubSourceUrl,
  syncGitHubSource,
  GitHubSourceError,
  type GitHubSourceInput,
  type GitHubSourceSnapshot,
  type GitHubSyncResult,
  type SyncErrorData,
  type SyncGitHubSourceInput,
} from "./source/github-source";
