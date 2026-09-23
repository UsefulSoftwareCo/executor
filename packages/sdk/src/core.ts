/** Public Effect-native SDK. The caller owns platform layers and resource lifetimes. */
export * from "./contracts/index.ts";
export { createExecutor, createRemoteExecutor } from "./implementation/create.ts";
export { executorHandlers } from "./implementation/handlers.ts";
export { bearerResourceMetadata } from "./implementation/oauth-challenge.ts";
export { subscribeAppQuery } from "./implementation/live.ts";
export {
  runtimeAdapter,
  toEffectRuntime,
  createAppRuntime,
  type AppRuntime,
  type ResolvedAppRuntime,
} from "./implementation/runtime.ts";
export { executorDatabase } from "./implementation/storage-migrations.ts";
export { makeExecutorStorage, type ExecutorDatabase } from "./implementation/storage.ts";

/** Optional Web Crypto adapter; callers retain signing-key custody. */
export { aesGcmCredentials } from "./implementation/credentials.ts";
export { webhookCallback } from "./implementation/webhook-http.ts";

export * from "./contracts/workflows.ts";
export {
  WorkflowHost,
  WorkflowSeed,
  WorkflowBackendState,
  type WorkflowRuntime,
  type WorkflowDriver,
} from "./contracts/workflow-runtime.ts";

export { recoverAppRepositories, AppRepositoryRecovery } from "./implementation/initial-source.ts";
