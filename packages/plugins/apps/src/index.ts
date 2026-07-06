// @executor-js/plugin-apps — custom tool publishing for executor.
//
// Custom tools are published into a per-scope store and invoked through the
// platform catalog path. Publish is the compiler (FDI); each substrate-specific
// capability sits behind a seam.

export * from "./seams";
export * from "./pipeline/descriptor";
export { discover, PublishError } from "./pipeline/discover";
export { bundleEntry, PLATFORM_MODULES, INLINABLE_MODULES } from "./pipeline/bundle";
export {
  publish,
  type PublishInput,
  type PublishOutput,
  type PublishDeps,
} from "./pipeline/publish";

export { makeAppsRuntime, type AppsRuntime, type AppsRuntimeDeps } from "./plugin/runtime";
export {
  makeAppsStore,
  type AppsStore,
  type AppsStoreDeps,
  descriptorCollection,
  scopeConnectionCollection,
} from "./plugin/store";
export {
  buildBridge,
  rootsFor,
  BindingError,
  type Bindings,
  type RoleBinding,
  type ClientResolver,
  type BindingContext,
} from "./plugin/bindings";
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
