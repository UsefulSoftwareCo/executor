// @executor-js/plugin-apps — the executor apps subsystem (self-hosted build).
//
// Custom tools, durable workflows, UI views, and skills: published into a
// per-scope store and served/executed by the platform. Publish is the compiler
// (FDI); every substrate-specific capability sits behind a seam.

export * from "./seams";
export * from "./pipeline/descriptor";
export { discover, PublishError } from "./pipeline/discover";
export { bundleEntry, PLATFORM_MODULES, INLINABLE_MODULES } from "./pipeline/bundle";
export {
  publish,
  type PublishInput,
  type PublishOutput,
  type PublishDeps,
  type PutBlob,
} from "./pipeline/publish";

export { makeAppsRuntime, type AppsRuntime, type AppsRuntimeDeps } from "./plugin/runtime";
export {
  makeAppsStore,
  type AppsStore,
  type AppsStoreDeps,
  descriptorCollection,
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
export { makeSqliteWorkflowRunner } from "./backing/sqlite-workflow-runner";
export { makeInProcessLiveChannel } from "./backing/in-process-live-channel";
