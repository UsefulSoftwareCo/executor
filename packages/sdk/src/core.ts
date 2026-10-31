/** Public Effect-native SDK. The caller owns platform layers and resource lifetimes. */
export * from "./contracts/index.ts";
export { createExecutor, createRemoteExecutor } from "./implementation/create.ts";
export { httpEventSender } from "./implementation/event-sender.ts";
export { makeDeclarationCache } from "./implementation/declarations.ts";
export { declarationConfig } from "./implementation/declaration-config.ts";
export { evaluatedDeclarations } from "./implementation/evaluated-declarations.ts";
export { executorHandlers } from "./implementation/handlers.ts";
export { rejectRequest, requestRejections } from "./implementation/request-rejection.ts";
export { probeOAuthChallenge } from "./implementation/oauth-probe.ts";
export { withExecutorUserAgent } from "./implementation/user-agent.ts";
export { discoverResourceOAuth } from "./implementation/oauth-protocol.ts";
export { bearerChallenge, bearerResourceMetadata } from "./implementation/oauth-challenge.ts";
export { subscribeAppQuery } from "./implementation/live.ts";
export { toolCallSpan } from "./implementation/tool-call-overhead.ts";
export {
  plainAccount,
  invocationAccounts,
  linkedRequirements,
  resolveLinkedAccounts,
  type LinkedAccounts,
  type RequirementLink,
  type LinkedRequirement,
} from "./implementation/linked-accounts.ts";
export {
  runtimeAdapter,
  toEffectRuntime,
  createAppRuntime,
  type AppRuntime,
  type ResolvedAppRuntime,
} from "./implementation/runtime.ts";
export { executorDatabase } from "./implementation/storage-migrations.ts";
export { makeExecutorStorage, type ExecutorDatabase } from "./implementation/storage.ts";
export {
  accountAcquisitionDriver,
  type PromiseAccountAcquisitionDriver,
} from "./implementation/account-acquisition-adapter.ts";

/** Optional Web Crypto adapter; callers retain signing-key custody. */
export { aesGcmCredentials } from "./implementation/credentials.ts";
/** Read another host's public catalog over HTTPS. */
export { remoteRegistry } from "./implementation/remote-registry.ts";
/** Registry results for clients that read an earlier wire revision. */
export {
  packageNameFromRevision,
  publicationForRevision,
  publicationsForRevision,
  readinessForRevision,
  registryForRevision,
  scopedNameFor,
} from "./implementation/wire-revision.ts";
export { webhookCallback } from "./implementation/webhook-http.ts";

export * from "./contracts/workflows.ts";
export {
  WorkflowHost,
  WorkflowSeed,
  WorkflowBackendState,
  type WorkflowRuntime,
  type WorkflowDriver,
} from "./contracts/workflow-runtime.ts";
export { decodeWorkflowFailure, workflowFailureMessage } from "./contracts/workflow-errors.ts";

export { AppRepositoryRecovery } from "./implementation/initial-source.ts";
export { asciiJson } from "./implementation/ascii-json.ts";
