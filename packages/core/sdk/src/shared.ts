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
  ArtifactId,
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
export { connectionIdentifier, isConnectionIdentifier } from "./connection-name-identifier";

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
  UpdateConnectionInput,
  ValidateConnectionInput,
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
  ConnectionAlreadyExistsError,
  ConnectionNotFoundError,
  InvalidConnectionInputError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  ArtifactNotFoundError,
  isUserActionableError,
  type ExecuteError,
  type ExecutorError,
  type UserActionableError,
} from "./errors";

// Elicitation wire schemas.
export {
  ElicitationMeta,
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
  patternSpecificity,
  positionForNewPattern,
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

// Artifact projections (the row mappers are server-side; the binding schemas
// are shared, because the HTTP contract carries them).
export { ArtifactBinding, ArtifactBindings } from "./artifact";
export type {
  Artifact,
  ArtifactPreview,
  ArtifactSummary,
  SaveArtifactInput,
  RenameArtifactInput,
  RemoveArtifactInput,
  SetArtifactPreviewInput,
} from "./artifact";
export { ARTIFACT_PREVIEW_MARKUP_LIMIT } from "./artifact-preview";

// Schema-side views + onboarding autodetect.
export { ToolSchemaView, IntegrationDetectionResult } from "./types";

export {
  decodeOAuthCallbackState,
  encodeOAuthCallbackState,
  type OAuthCallbackState,
} from "./oauth";

// Health-check vocabulary (pure Schema + helpers).
export {
  HealthStatus,
  HealthCheckReason,
  HealthCheckSpec,
  HealthCheckResult,
  HealthCheckCandidate,
  HealthCheckCandidateParameter,
  classifyHttpStatus,
  classifyProbeResponse,
  extractIdentity,
  compareHealthCheckCandidates,
  candidateIdentityTier,
  sortHealthCheckCandidatesByIdentity,
  identityPathTier,
  isToolSyncHealth,
  rankResponseSample,
} from "./health-check";

// OAuth wire contracts (data + tagged errors; the flow impl is server-only).
export {
  FIRST_PARTY_OAUTH_CLIENT_PREFIX,
  firstPartyOAuthClientSlug,
  isFirstPartyOAuthClientSlug,
  SubjectTokenTypeSchema,
  DEFAULT_SUBJECT_TOKEN_TYPE,
  EnterpriseManagedStartInputSchema,
  EnterpriseIdentityProviderDescriptorSchema,
  TokenEndpointAuthMethodSchema,
  type SubjectTokenType,
  type EnterpriseManagedStartInput,
  type EnterpriseIdentityProviderDescriptor,
  type TokenEndpointAuthMethod,
  isTokenEndpointAuthMethod,
  type FirstPartyOAuthClientConfig,
  type OAuthGrant,
  type OAuthAuthentication,
  type OAuthClient,
  type OAuthClientOrigin,
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
  EXECUTOR_ORG_SELECTOR_HEADER,
  ExecutorServerHeaderResolutionError,
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  parseExecutorLocalServerManifest,
  resolveExecutorServerConfiguredHeaders,
  resolveExecutorServerRequestHeaders,
  serializeExecutorLocalServerManifest,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
  type ExecutorServerConnectionKind,
  type ExecutorServerHeaders,
  type ExecutorServerHeaderValue,
  type ExecutorLocalServerKind,
  type ExecutorLocalServerManifest,
} from "./server-connection";

// OAuth popup postMessage contract (browser-safe).
export {
  OAUTH_POPUP_MESSAGE_TYPE,
  type OAuthPopupResult,
  isOAuthPopupResult,
} from "./oauth-popup-types";

// URL redaction for exported telemetry (browser-safe — pure Effect). The
// browser client provides the redacting OTLP serialization to its exporter so
// page-side spans are scrubbed before they leave the page.
export {
  redactOtlpTraceExport,
  redactSpanUrlAttributes,
  redactUrlForTelemetry,
  redactUrlsInText,
  STRIPPED_QUERY_ATTRIBUTE,
  UrlRedactingOtlpSerializationJson,
  type RedactedUrl,
} from "./telemetry-url-redaction";
