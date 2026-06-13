// ---------------------------------------------------------------------------
// @executor-js/sdk/promise — public surface for Promise-based consumers.
// ---------------------------------------------------------------------------

export {
  createExecutor,
  type Executor,
  type ExecutorConfig,
  type PromiseInvokeOptions,
  type PromiseOnElicitation,
  type Promisified,
} from "./promise-executor";

// Identity / projection types that don't carry Effect in their signatures
// are safe to re-export from the Effect surface. Promise consumers need
// these to type arguments they pass in (filters, refs, ids).
export {
  Tenant,
  Subject,
  Owner,
  IntegrationSlug,
  ConnectionName,
  AuthTemplateSlug,
  ProviderKey,
  ProviderItemId,
  ToolAddress,
  ToolName,
  PolicyId,
} from "./ids";
export type { Integration } from "./integration";
export type {
  Connection,
  ConnectionRef,
  CreateConnectionInput,
  UpdateConnectionInput,
  ConnectionValueInput,
} from "./connection";
// Credential providers are Effect-native (their `get`/`set` return `Effect`s),
// but Promise consumers still author them to register an inline writable store
// via `createExecutor({ providers })`.
export type { CredentialProvider, ProviderEntry } from "./provider";
export type {
  CreateToolPolicyInput,
  RemoveToolPolicyInput,
  UpdateToolPolicyInput,
} from "./policies";
export { ToolSchemaView, IntegrationDetectionResult } from "./types";
export type { Tool, ToolDef, ToolListFilter, ToolAnnotations } from "./tool";
export type { AnyPlugin, PluginExtensions } from "./plugin";
export type {
  PromiseOnElicitation as OnElicitation,
  PromiseInvokeOptions as InvokeOptions,
} from "./promise-executor";

// Elicitation — Promise invoke returns raw values, but consumers still
// may want to reference request/response shapes.
export {
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  type ElicitationRequest,
  type ElicitationContext,
  type ElicitationHandler,
} from "./elicitation";

// File-config helper for the CLI. Plain typed-object factory with no
// Effect in its signature, so it's safe to live on the Promise surface.
export { defineExecutorConfig, type ExecutorCliConfig } from "./config";

// Error tags — Promise callers handle these via .catch().
export {
  ToolNotFoundError,
  ToolInvocationError,
  ToolBlockedError,
  NoHandlerError,
  PluginNotLoadedError,
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  IntegrationNotFoundError,
  IntegrationRemovalNotAllowedError,
  type ExecutorError,
} from "./errors";
