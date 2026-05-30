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

// FumaDB integration.
export { fumadb } from "fumadb";
export type { FumaDB } from "fumadb";
export type { AbstractQuery, Condition, ConditionBuilder } from "fumadb/query";
export { column, idColumn, schema as fumaSchema, table } from "fumadb/schema";
export type { AnyColumn, AnySchema, AnyTable, Column, Schema as FumaSchema } from "fumadb/schema";

export type {
  FumaDb,
  FumaQuery,
  FumaRow,
  FumaTables,
  IFumaClient,
  StorageFailure,
} from "./fuma-runtime";
export { StorageError, UniqueViolationError, isStorageFailure } from "./fuma-runtime";

// Storage-layer typed errors are still exported so plugin code can catchTag
// `UniqueViolationError`, but FumaDB itself is the storage API.

// IDs (branded)
export { ScopeId, ToolId, SecretId, PolicyId, ConnectionId, CredentialBindingId } from "./ids";

// Scope
export {
  Scope,
  defaultSourceInstallScopeId,
  userOrgScopeId,
  parseUserOrgScopeId,
  makeUserOrgScopeStack,
} from "./scope";

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
  ToolSchemaView,
  SourceDetectionResult,
  type RefreshSourceInput,
  type RemoveSourceInput,
  type Source,
  type ToolView,
  type ToolListFilter,
} from "./types";

// Core schema
export {
  bigintColumn,
  boolColumn,
  coreSchema,
  dateColumn,
  isToolPolicyAction,
  jsonColumn,
  nullableBigintColumn,
  nullableJsonColumn,
  nullableTextColumn,
  scopedExecutorTable,
  textColumn,
  TOOL_POLICY_ACTIONS,
  type CoreSchema,
  type SourceInput,
  type SourceInputTool,
  type SourceRow,
  type ToolRow,
  type DefinitionRow,
  type SecretRow,
  type ConnectionRow,
  type PluginStorageRow,
  type CredentialBindingRow,
  type ToolPolicyRow,
  type ToolPolicyAction,
  type DefinitionsInput,
  type ToolAnnotations,
} from "./core-schema";

// Tool policies. `matchPattern`/`isValidPattern` are consumed by the React UI;
// `effectivePolicyFromSorted` + `ToolPolicyActionSchema` are shared contracts.
// `resolveToolPolicy`/`resolveEffectivePolicy`/`rowToToolPolicy` are off the
// barrel: they are SDK-internal (used inside `createExecutor`), not a plugin or
// consumer contract.
export {
  matchPattern,
  isValidPattern,
  effectivePolicyFromSorted,
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
  ScopedSecretCredentialInput,
  CredentialBindingRef,
  CredentialBindingSlotInput,
  RemoveCredentialBindingInput,
  RemoveSourceCredentialBindingInput,
  ReplaceCredentialBindingValue,
  ReplaceCredentialBindingsInput,
  ReplaceSourceCredentialBindingsInput,
  CredentialBindingResolutionStatus,
  ResolvedCredentialSlot,
  SetSourceCredentialBindingInput,
  SourceCredentialBindingSource,
  SourceCredentialBindingSourceInput,
  SourceCredentialBindingSlotInput,
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

// Blob store — the plugin-facing CONTRACT only. The concrete makers
// (`makeFumaBlobStore`/`makeInMemoryBlobStore`) are SDK-internal: `createExecutor`
// wires the blob store, plugins only ever receive a `PluginBlobStore`.
export { type BlobStore, type PluginBlobStore, pluginBlobStore } from "./blob";

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

// NOTE: the OAuth 2.1 implementation helpers (PKCE/exchange/refresh in
// `./oauth-helpers`, `makeOAuth2Service` in `./oauth-service`, and the dynamic
// discovery/registration in `./oauth-discovery`) are SDK-internal: they are
// consumed only by `createExecutor`'s built-in OAuth flow, never by plugins.
// The plugin-facing OAuth CONTRACTS (the schemas/types + `OAUTH2_PROVIDER_KEY`)
// stay exported above. The hosted HTTP client builder is host-internal too and
// reachable via `@executor-js/sdk/host-internal`.

export {
  DEFAULT_EXECUTOR_SERVER_ORIGIN,
  DEFAULT_EXECUTOR_SERVER_USERNAME,
  apiBaseUrlForServerOrigin,
  getExecutorServerAuthorizationHeader,
  normalizeExecutorServerConnection,
  normalizeExecutorServerOrigin,
  originFromApiBaseUrl,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
  type ExecutorServerConnectionKind,
} from "./server-connection";

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
  type StaticToolSchema,
  type StaticToolExecuteContext,
  type StaticToolHandlerInput,
  type StaticToolInput,
  type ConfigureSourceHandlerInput,
  type InvokeToolInput,
  type SourceLifecycleInput,
  type SourceConfigureDecl,
  type SecretListEntry,
  type Elicit,
  definePlugin,
  tool,
} from "./plugin";
export {
  pluginStorageId,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type PluginStorageKeyInput,
  type PluginStorageListInput,
  type PluginStoragePutInput,
  type PluginStorageScopedKeyInput,
} from "./plugin-storage";

// Executor
//
// `collectTables` is host/tooling-only (cli schema cmd, kernel worker,
// local/cloud DB bring-up). Its definition stays here because `createExecutor`
// uses it; the host surface (`@executor-js/api/server`) re-exports it so hosts
// import it alongside the other host-composition seams. The CLI + kernel
// tooling, which only depend on `@executor-js/sdk` (not `@executor-js/api`),
// keep importing it from here.
export {
  type Executor,
  type ExecutorConfig,
  type ExecutorDb,
  type ExecutorDbFactory,
  type ExecutorDbInput,
  type OnElicitation,
  type InvokeOptions,
  createExecutor,
  collectTables,
} from "./executor";

// NOTE: the host-composition seams (`DbProvider`/`dbProviderLayer`,
// `makeScopedExecutor`/`HostConfig`/`PluginsProvider`, `createExecutorFumaDb`)
// are NOT on this plugin-author barrel — they live in the host surface
// (`@executor-js/api/server`). The pure FumaDB assembly stays in the SDK for the
// sqlite test backend and is exposed to the host layer via
// `@executor-js/sdk/host-internal`.

// CLI / runtime config
export {
  defineExecutorConfig,
  type ExecutorCliConfig,
  type ExecutorPluginsFactory,
} from "./config";

// NOTE: the JSON-schema `$ref` helpers (`./schema-refs`) and the TypeScript
// preview generators (`./schema-types`) are SDK-internal — `./schema-types`
// consumes `./schema-refs`, and `buildToolTypeScriptPreview` is used only inside
// `createExecutor`. No plugin imports them, so they are off the barrel.

// Wire-level HTTP error schemas usable by plugin HttpApiGroup definitions.
export { InternalError } from "./api-errors";

// ToolResult — typed value-based discriminated union for tool outcomes.
// Distinct from the `ToolView` row projection (`./types`) and the `tool()`
// builder (`./plugin`): one word per concept, three names.
export { ToolResult, isToolResult, type ToolError } from "./tool-result";
export {
  authToolFailure,
  type AuthToolFailureCode,
  type AuthToolFailureInput,
} from "./auth-tool-failure";
