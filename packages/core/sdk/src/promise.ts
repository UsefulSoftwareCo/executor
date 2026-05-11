// ---------------------------------------------------------------------------
// @executor-js/sdk/promise — public surface for Promise-based consumers.
// ---------------------------------------------------------------------------

export {
  createExecutor,
  type Executor,
  type ExecutorConfig,
  type Promisified,
} from "./promise-executor";

// Identity / projection types that don't carry Effect in their signatures
// are safe to re-export from the Effect surface. Promise consumers need
// these to type arguments they pass in (e.g. SetSecretInput, filters).
export { ScopeId, ToolId, SecretId, PolicyId } from "./ids";
export { Scope } from "./scope";
export { RemoveConnectionInput } from "./connections";
export { RemoveSecretInput, SecretRef, SetSecretInput } from "./secrets";
export type {
  CreateToolPolicyInput,
  RemoveToolPolicyInput,
  UpdateToolPolicyInput,
} from "./policies";
export {
  ToolSchema,
  SourceDetectionResult,
  type RefreshSourceInput,
  type RemoveSourceInput,
  type Source,
  type Tool,
  type ToolListFilter,
} from "./types";
export type { ToolAnnotations } from "./core-schema";
export type { AnyPlugin, PluginExtensions } from "./plugin";
export type { OnElicitation, InvokeOptions } from "./executor";

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

// Secret-backed values — referenced by every plugin's source-config
// schemas (headers/queryParams). Re-exported here so plugin packages
// that target the Promise surface don't need to reach into `/core`.
export {
  SecretBackedValue,
  SecretBackedMap,
  isSecretBackedRef,
  resolveSecretBackedMap,
  type ResolveSecretBackedMapOptions,
} from "./secret-backed-value";

// File-config helper for the CLI. Plain typed-object factory with no
// Effect in its signature, so it's safe to live on the Promise surface.
export { defineExecutorConfig, type ExecutorCliConfig, type ExecutorDialect } from "./config";

// Error tags — Promise callers handle these via .catch().
export {
  ToolNotFoundError,
  ToolInvocationError,
  NoHandlerError,
  SourceNotFoundError,
  SourceRemovalNotAllowedError,
  PluginNotLoadedError,
  SecretNotFoundError,
  SecretResolutionError,
  type ExecutorError,
} from "./errors";
