// ---------------------------------------------------------------------------
// @executor-js/sdk — public surface
// ---------------------------------------------------------------------------

// Re-export the Effect/Schema/HttpApi primitives plugin authors need so a
// plugin can be written importing only from `@executor-js/sdk`. Authors who
// want to reach for additional Effect APIs keep importing from `effect/*`
// directly — these re-exports are the curated minimum.
export { Context, Effect, Layer, Schema, Data, Option } from "effect";
export {
  HttpApi,
  HttpApiBuilder,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
} from "effect/unstable/httpapi";

// Storage adapter interface types (re-exported from @executor-js/storage-core
// so plugin authors can write adapters against a single public surface
// without depending on storage-core directly).
export type {
  DBAdapter,
  DBSchema,
  DBFieldAttribute,
  DBFieldType,
  StorageFailure,
  TypedAdapter,
  Where,
  WhereOperator,
} from "@executor-js/storage-core";

export { typedAdapter } from "@executor-js/storage-core";

// Storage-layer typed errors (re-exported so plugin code can catchTag
// `UniqueViolationError` without importing storage-core directly).
export { StorageError, UniqueViolationError } from "@executor-js/storage-core";

// IDs (branded)
export { ScopeId, ToolId, SecretId, PolicyId, ConnectionId, CredentialBindingId } from "./ids";

// Scope
export { Scope } from "./scope";

// Errors (tagged)
export {
  ToolNotFoundError,
  ToolInvocationError,
  ToolBlockedError,
  NoHandlerError,
  SourceNotFoundError,
  SourceRemovalNotAllowedError,
  PluginNotLoadedError,
  SecretNotFoundError,
  SecretResolutionError,
  SecretOwnedByConnectionError,
  SecretInUseError,
  ConnectionNotFoundError,
  ConnectionProviderNotRegisteredError,
  ConnectionRefreshNotSupportedError,
  ConnectionReauthRequiredError,
  ConnectionInUseError,
  type ExecutorError,
} from "./errors";

// Public projections
export {
  ToolSchema,
  SourceDetectionResult,
  type RefreshSourceInput,
  type RemoveSourceInput,
  type Source,
  type Tool,
  type ToolListFilter,
} from "./types";

// Core schema
export {
  coreSchema,
  isToolPolicyAction,
  TOOL_POLICY_ACTIONS,
  type CoreSchema,
  type SourceInput,
  type SourceInputTool,
  type SourceRow,
  type ToolRow,
  type DefinitionRow,
  type SecretRow,
  type ConnectionRow,
  type CredentialBindingRow,
  type ToolPolicyRow,
  type ToolPolicyAction,
  type DefinitionsInput,
  type ToolAnnotations,
} from "./core-schema";

// Tool policies
export {
  matchPattern,
  isValidPattern,
  resolveToolPolicy,
  resolveEffectivePolicy,
  effectivePolicyFromSorted,
  rowToToolPolicy,
  ToolPolicyActionSchema,
  type ToolPolicy,
  type CreateToolPolicyInput,
  type UpdateToolPolicyInput,
  type RemoveToolPolicyInput,
  type PolicyMatch,
  type EffectivePolicy,
  type PolicySource,
} from "./policies";

// Secrets
export { SecretRef, SetSecretInput, RemoveSecretInput, type SecretProvider } from "./secrets";

export {
  SecretBackedMap,
  SecretBackedValue,
  isSecretBackedRef,
  resolveSecretBackedMap,
  type ResolveSecretBackedMapOptions,
} from "./secret-backed-value";

export {
  CredentialBindingKind,
  CredentialBindingValue,
  ConfiguredCredentialBinding,
  ConfiguredCredentialValue,
  ConfiguredCredentialValueSchema,
  ScopedSecretCredentialInput,
  CredentialBindingRef,
  SetCredentialBindingInput,
  CredentialBindingSourceInput,
  CredentialBindingSlotInput,
  RemoveCredentialBindingInput,
  ReplaceCredentialBindingValue,
  ReplaceCredentialBindingsInput,
  CredentialBindingResolutionStatus,
  ResolvedCredentialSlot,
  credentialBindingId,
  credentialSlotKey,
  credentialSlotPart,
  credentialBindingRowToRef,
  credentialBindingValueFromRow,
  type CredentialBindingsFacade,
} from "./credential-bindings";

// Usage tracking — secret/connection refs across plugins
export { Usage, type UsagesForSecretInput, type UsagesForConnectionInput } from "./usages";

// Connections
export {
  ConnectionRef,
  ConnectionProviderState,
  CreateConnectionInput,
  RemoveConnectionInput,
  UpdateConnectionTokensInput,
  TokenMaterial,
  ConnectionRefreshError,
  type ConnectionProvider,
  type ConnectionRefreshInput,
  type ConnectionRefreshResult,
} from "./connections";

// Elicitation
export {
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  ElicitationDeclinedError,
  type ElicitationRequest,
  type ElicitationHandler,
  type ElicitationContext,
} from "./elicitation";

// Blob store
export {
  type BlobStore,
  type PluginBlobStore,
  pluginBlobStore,
  makeInMemoryBlobStore,
} from "./blob";

// OAuth 2.1
export {
  type OAuthService,
  type OAuthStrategy,
  type OAuthDynamicDcrStrategy,
  type OAuthAuthorizationCodeStrategy,
  type OAuthClientCredentialsStrategy,
  type OAuthProviderState,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthStartInput,
  type OAuthStartResult,
  type OAuthCompleteInput,
  type OAuthCompleteResult,
  OAuthProbeError,
  OAuthStartError,
  OAuthCompleteError,
  OAuthSessionNotFoundError,
  OAUTH2_PROVIDER_KEY,
  OAUTH2_SESSION_TTL_MS,
  OAuthStrategy as OAuthStrategySchema,
  OAuthProviderState as OAuthProviderStateSchema,
  OAuthDynamicDcrStrategy as OAuthDynamicDcrStrategySchema,
  OAuthAuthorizationCodeStrategy as OAuthAuthorizationCodeStrategySchema,
  OAuthClientCredentialsStrategy as OAuthClientCredentialsStrategySchema,
} from "./oauth";

export {
  OAuth2Error,
  OAUTH2_DEFAULT_TIMEOUT_MS,
  OAUTH2_REFRESH_SKEW_MS,
  assertSupportedOAuthEndpointUrl,
  buildAuthorizationUrl,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  isSupportedOAuthEndpointUrl,
  refreshAccessToken,
  shouldRefreshToken,
  type OAuth2TokenResponse,
  type BuildAuthorizationUrlInput,
  type ClientAuthMethod,
  type ExchangeAuthorizationCodeInput,
  type ExchangeClientCredentialsInput,
  type RefreshAccessTokenInput,
} from "./oauth-helpers";

export { makeOAuth2Service, type OAuthServiceDeps } from "./oauth-service";
export type { ScopedDBAdapter, ScopedTypedAdapter } from "./scoped-adapter";

export {
  HostedOutboundRequestBlocked,
  makeHostedHttpClientLayer,
  validateHostedOutboundUrl,
  type HostedHttpClientOptions,
} from "./hosted-http-client";

export {
  OAuthDiscoveryError,
  OAuthAuthorizationServerMetadataSchema,
  OAuthClientInformationSchema,
  OAuthProtectedResourceMetadataSchema,
  beginDynamicAuthorization,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
  registerDynamicClient,
  type BeginDynamicAuthorizationInput,
  type DiscoveryRequestOptions,
  type DynamicAuthorizationState,
  type DynamicAuthorizationStartResult,
  type DynamicClientMetadata,
  type OAuthAuthorizationServerMetadata,
  type OAuthClientInformation,
  type OAuthProtectedResourceMetadata,
  type RegisterDynamicClientInput,
} from "./oauth-discovery";

export {
  OAUTH_POPUP_MESSAGE_TYPE,
  type OAuthPopupResult,
  isOAuthPopupResult,
} from "./oauth-popup-types";

// Plugin definition
export {
  type Plugin,
  type PluginSpec,
  type PluginCtx,
  type PluginExtensions,
  type ConfiguredPlugin,
  type AnyPlugin,
  type StorageDeps,
  type StaticSourceDecl,
  type StaticToolDecl,
  type StaticToolHandlerInput,
  type InvokeToolInput,
  type SourceLifecycleInput,
  type SecretListEntry,
  type Elicit,
  definePlugin,
  defineSchema,
} from "./plugin";

// Executor
export {
  type Executor,
  type ExecutorConfig,
  type OnElicitation,
  type InvokeOptions,
  createExecutor,
  collectSchemas,
} from "./executor";

// CLI / runtime config
export {
  defineExecutorConfig,
  type ExecutorCliConfig,
  type ExecutorDialect,
  type ExecutorPluginsFactory,
} from "./config";

// Test helper
export { makeTestConfig } from "./test-config";

// JSON schema $ref helpers (used by openapi for $defs handling)
export { hoistDefinitions, collectRefs, reattachDefs, normalizeRefs } from "./schema-refs";

// TypeScript preview generation from JSON schemas
export {
  schemaToTypeScriptPreview,
  schemaToTypeScriptPreviewWithDefs,
  buildToolTypeScriptPreview,
  type TypeScriptRenderOptions,
  type TypeScriptSchemaPreview,
} from "./schema-types";
