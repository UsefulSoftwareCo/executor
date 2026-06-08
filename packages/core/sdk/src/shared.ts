// ---------------------------------------------------------------------------
// @executor-js/sdk/shared — browser-safe domain contracts.
//
// For React and plugin UI code that needs the v2 runtime ids, tagged errors,
// policy helpers, and wire contracts without importing the server/plugin SDK
// root (which pulls fumadb / node). Everything re-exported here must be
// browser-safe: pure Effect/Schema, no `fuma-runtime` / `core-schema` value
// imports. (The `ToolPolicyAction` *type* is fine — types erase at runtime.)
// ---------------------------------------------------------------------------

// Branded ids + the owner literal.
export {
  AuthTemplateSlug,
  ConnectionAddress,
  ConnectionName,
  ElicitationId,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  Owner,
  PolicyId,
  ProviderItemId,
  ProviderKey,
  Subject,
  Tenant,
  ToolAddress,
  ToolName,
} from "./ids";

// Domain projections (types only — no runtime cost).
export type {
  AuthMethodDescriptor,
  AuthMethodOAuthDescriptor,
  AuthPlacementDescriptor,
  Integration,
  IntegrationConfig,
  IntegrationDisplayDescriptor,
} from "./integration";
export type {
  Connection,
  ConnectionRef,
  ConnectionValueInput,
  CreateConnectionInput,
} from "./connection";
export type { CredentialProvider, ProviderEntry } from "./provider";
export type { Tool, ToolDef, ToolListFilter, ToolAnnotations } from "./tool";

// Tagged errors (Schema-based — browser-safe).
export {
  ToolNotFoundError,
  ToolInvocationError,
  ToolBlockedError,
  PluginNotLoadedError,
  NoHandlerError,
  IntegrationNotFoundError,
  IntegrationAlreadyExistsError,
  IntegrationRemovalNotAllowedError,
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  type ExecuteError,
  type ExecutorError,
} from "./errors";

// Elicitation wire schemas.
export {
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  ElicitationDeclinedError,
  type ElicitationRequest,
  type ElicitationContext,
  type ElicitationHandler,
  type OnElicitation,
  type InvokeOptions,
} from "./elicitation";

// Tool-policy helpers + projections (pure functions / Schema).
export {
  matchPattern,
  isValidPattern,
  effectivePolicyFromSorted,
  comparePolicyRow,
  ToolPolicyActionSchema,
  type ToolPolicy,
  type CreateToolPolicyInput,
  type UpdateToolPolicyInput,
  type RemoveToolPolicyInput,
  type PolicyMatch,
  type EffectivePolicy,
  type PolicySource,
} from "./policies";
export type { ToolPolicyAction } from "./core-schema";

// Schema-side views + onboarding autodetect.
export { ToolSchemaView, IntegrationDetectionResult } from "./types";

// OAuth wire contracts (data + tagged errors; the flow impl is server-only).
export {
  type OAuthGrant,
  type OAuthAuthentication,
  type OAuthClient,
  type OAuthClientSummary,
  type CreateOAuthClientInput,
  type RegisterDynamicClientInput,
  type ConnectResult,
  type OAuthStartInput,
  type OAuthCompleteInput,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthService,
  OAuthStartError,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
} from "./oauth-client";

// Wire-level HTTP error schema for plugin HttpApiGroup definitions.
export { InternalError } from "./api-errors";

// Executor server connection contracts (browser-safe).
export {
  DEFAULT_EXECUTOR_SERVER_ORIGIN,
  DEFAULT_EXECUTOR_SERVER_USERNAME,
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  parseExecutorLocalServerManifest,
  serializeExecutorLocalServerManifest,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
  type ExecutorServerConnectionKind,
  type ExecutorLocalServerKind,
  type ExecutorLocalServerManifest,
} from "./server-connection";

// OAuth popup postMessage contract (browser-safe).
export {
  OAUTH_POPUP_MESSAGE_TYPE,
  type OAuthPopupResult,
  isOAuthPopupResult,
} from "./oauth-popup-types";
