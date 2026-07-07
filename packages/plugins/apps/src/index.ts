// @executor-js/plugin-apps — custom tool publishing for executor.
//
// Custom tools are published into a per-scope store and invoked through the
// platform catalog path. Publish is the compiler (FDI); each substrate-specific
// capability sits behind a seam.

export * from "./seams";
export * from "./authoring";
export * from "./standard-schema";
export * from "./pipeline/descriptor";
export { discover, PublishError } from "./pipeline/discover";
export { bundleEntry, PLATFORM_MODULES, INLINABLE_MODULES } from "./pipeline/bundle";
export {
  publish,
  type PublishInput,
  type PublishOutput,
  type PublishDeps,
} from "./pipeline/publish";
export {
  fetchGitHubSource,
  syncGitHubSource,
  GitHubSourceError,
  type GitHubSourceInput,
  type GitHubSourceSnapshot,
  type GitHubSyncResult,
  type SyncErrorData,
  type SyncGitHubSourceInput,
} from "./source/github-source";

export { makeAppsRuntime, type AppsRuntime, type AppsRuntimeDeps } from "./plugin/runtime";
export { makeAppsRuntimeFromBackings, type AppsBackings } from "./plugin/backings";
export {
  makeAppsStore,
  type AppsStore,
  type AppsStoreDeps,
  type GitHubSourceTokenRef,
  descriptorCollection,
} from "./plugin/store";
export {
  slugifyCustomToolsAppName,
  validateCustomToolsAppSlug,
  CUSTOM_TOOLS_APP_SLUG_PATTERN,
} from "./source/app-slug";
export {
  buildBridge,
  rootsFor,
  resolveIntegrationBindings,
  BindingError,
  type ConnectionCandidate,
  type RoleBindings,
  type ClientResolver,
  type BindingContext,
} from "./plugin/bindings";
export { makePluginCtxAppsResolver } from "./plugin/resolver";
export {
  makeSelfHostAppsRuntime,
  type SelfHostAppsRuntime,
  type SelfHostAppsRuntimeOptions,
} from "./plugin/self-host-runtime";

// Self-host seam backings.
export { makeGitArtifactStore } from "./backing/git-artifact-store";
export { makeLibsqlScopeDb } from "./backing/libsql-scope-db";
export { makeQuickjsToolSandbox } from "./backing/quickjs-tool-sandbox";
export { makeSqliteAppsStore } from "./backing/sqlite-apps-store";
