// ---------------------------------------------------------------------------
// @executor-js/sdk — public surface (v2)
// ---------------------------------------------------------------------------

// Re-export the Effect/Schema/HttpApi primitives plugin authors need so a
// plugin can be written importing only from `@executor-js/sdk`.
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
export { fumadb } from "@executor-js/fumadb";
export type { FumaDB } from "@executor-js/fumadb";
export type { AbstractQuery, Condition, ConditionBuilder } from "@executor-js/fumadb/query";
export { column, idColumn, schema as fumaSchema, table } from "@executor-js/fumadb/schema";
export type {
  AnyColumn,
  AnySchema,
  AnyTable,
  Column,
  Schema as FumaSchema,
} from "@executor-js/fumadb/schema";

export type {
  FumaDb,
  FumaQuery,
  FumaRow,
  FumaTables,
  IFumaClient,
  StorageFailure,
} from "./fuma-runtime";
export { StorageError, UniqueViolationError, isStorageFailure } from "./fuma-runtime";

// IDs (branded) — the v2 set.
export {
  IntegrationSlug,
  AuthTemplateSlug,
  ConnectionName,
  OAuthClientSlug,
  OAuthState,
  ProviderKey,
  ProviderItemId,
  ConnectionAddress,
  ToolAddress,
  ToolName,
  ElicitationId,
  PolicyId,
  Tenant,
  Subject,
  Owner,
} from "./ids";
export { connectionIdentifier, isConnectionIdentifier } from "./connection-name-identifier";

// Errors (tagged) — the ExecuteError set + integration lifecycle.
export {
  ToolNotFoundError,
  ToolInvocationError,
  ToolBlockedError,
  NoHandlerError,
  PluginNotLoadedError,
  IntegrationNotFoundError,
  IntegrationAlreadyExistsError,
  IntegrationRemovalNotAllowedError,
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  type ExecuteError,
  type ExecutorError,
} from "./errors";

// Integration / connection / tool domain contracts.
export type {
  AuthMethodDescriptor,
  AuthMethodOAuthDescriptor,
  AuthPlacementDescriptor,
  Integration,
  IntegrationConfig,
  IntegrationDisplayDescriptor,
  RegisterIntegrationInput,
} from "./integration";
export { freshCustomAuthSlug, mergeAuthTemplates } from "./integration";
export type {
  Connection,
  ConnectionRef,
  ConnectionValueInput,
  CreateConnectionInput,
  UpdateConnectionInput,
} from "./connection";
export type { Tool, ToolDef, ToolListFilter, ToolAnnotations } from "./tool";

// Credential providers.
export type { CredentialProvider, ProviderEntry } from "./provider";

// Public projections / detection.
export { ToolSchemaView, IntegrationDetectionResult } from "./types";

// Core schema.
export {
  bigintColumn,
  boolColumn,
  coreSchema,
  coreTables,
  dateColumn,
  isToolPolicyAction,
  jsonColumn,
  keyColumn,
  nullableBigintColumn,
  nullableJsonColumn,
  nullableKeyColumn,
  nullableTextColumn,
  textColumn,
  TOOL_POLICY_ACTIONS,
  type CoreSchema,
  type IntegrationRow,
  type ConnectionRow,
  type OAuthClientRow,
  type OAuthSessionRow,
  type ToolRow,
  type ToolInvocationRow,
  type DefinitionRow,
  type ToolPolicyRow,
  type PluginStorageRow,
  type BlobRow,
  type ToolPolicyAction,
} from "./core-schema";

// Owner policy.
export {
  ORG_SUBJECT,
  executorOwnerPolicyName,
  executorUnscopedPolicyName,
  type ExecutorOwnerPolicyContext,
} from "./owner-policy";

// Tool policies.
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

// Elicitation.
export {
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  ElicitationDeclinedError,
  type ElicitationRequest,
  type ElicitationHandler,
  type ElicitationContext,
  type OnElicitation,
  type InvokeOptions,
} from "./elicitation";

// Blob store — the plugin-facing contract (`BlobStore`/`PluginBlobStore`)
// plus the platform-neutral backends (`makeFumaBlobStore` default,
// `makeInMemoryBlobStore` for tests). Platform-specific backends live with
// their host (R2: `@executor-js/cloudflare/blob-store`).
export {
  pluginBlobStore,
  makeInMemoryBlobStore,
  makeFumaBlobStore,
  sha256Hex,
  type BlobStore,
  type PluginBlobStore,
  type OwnerPartitions,
} from "./blob";

// Plugin storage.
export {
  definePluginStorageCollection,
  pluginStorageId,
  type PluginStorageCollectionDefinition,
  type PluginStorageCollectionFacade,
  type PluginStorageCollectionIndexedField,
  type PluginStorageCollectionKeyInput,
  type PluginStorageCollectionListInput,
  type PluginStorageCollectionOrderBy,
  type PluginStorageCollectionPutInput,
  type PluginStorageCollectionQueryInput,
  type PluginStorageCollectionScopedKeyInput,
  type PluginStorageCollectionWhere,
  type PluginStorageConfig,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type PluginStorageIndexField,
  type PluginStorageIndexSpec,
  type PluginStorageKeyInput,
  type PluginStorageListInput,
  type PluginStoragePutInput,
  type PluginStorageRuntimeCollectionDefinition,
  type PluginStorageRuntimeIndexSpec,
  type PluginStorageSchema,
  type PluginStorageSchemaType,
  type PluginStorageScopedKeyInput,
  type PluginStorageWhereFilter,
  type PluginStorageWhereValue,
} from "./plugin-storage";

// OAuth (v2 contracts).
export { OAUTH2_PROVIDER_KEY, OAUTH2_SESSION_TTL_MS } from "./oauth";
export {
  OAuthStartError,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
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
} from "./oauth-client";

// NOTE: the OAuth 2.1 implementation helpers (`./oauth-helpers`,
// `makeOAuthService` in `./oauth-service`, discovery in `./oauth-discovery`)
// are SDK-internal — consumed only by `createExecutor`. The hosted HTTP client
// builder is host-internal and reachable via `@executor-js/sdk/host-internal`.

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

// Plugin definition.
export {
  type Plugin,
  type PluginSpec,
  type PluginCtx,
  type PluginExtensions,
  type ConfiguredPlugin,
  type AnyPlugin,
  type StorageDeps,
  type OwnerBinding,
  type IntegrationRecord,
  type StaticSourceDecl,
  type StaticToolDecl,
  type StaticToolSchema,
  type StaticToolExecuteContext,
  type StaticToolHandlerInput,
  type StaticToolInput,
  type ConfigureIntegrationHandlerInput,
  type InvokeToolInput,
  type ConnectionLifecycleInput,
  type IntegrationConfigureDecl,
  type IntegrationConfigureSchema,
  type IntegrationPreset,
  type IntegrationPresetCatalogEntry,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type ToolInvocationCredential,
  type Elicit,
  definePlugin,
  tool,
} from "./plugin";

// Executor.
//
// `collectTables` is host/tooling-only (cli schema cmd, kernel worker,
// local/cloud DB bring-up). Its definition stays here because `createExecutor`
// uses it; the host surface (`@executor-js/api/server`) re-exports it.
export {
  type Executor,
  type ExecutorConfig,
  type ExecutorDb,
  type ExecutorDbFactory,
  type ExecutorDbInput,
  type ParsedToolAddress,
  createExecutor,
  collectTables,
  parseToolAddress,
  connectionAddress,
  toolAddress,
} from "./executor";

// CLI / runtime config.
export {
  defineExecutorConfig,
  type ExecutorCliConfig,
  type ExecutorPluginsFactory,
} from "./config";

// The one TS-preview generator plugins assert against.
export { buildToolTypeScriptPreview } from "./schema-types";

// Wire-level HTTP error schemas usable by plugin HttpApiGroup definitions.
export { InternalError } from "./api-errors";

// ToolResult — typed value-based discriminated union for tool outcomes.
export {
  ToolResult,
  annotateToolResultOutcome,
  isToolResult,
  type ToolError,
  type ToolHttpMeta,
} from "./tool-result";

// Stamped boot-time data-migration ledger for the libSQL-backed apps.
export {
  DataMigrationError,
  DuplicateDataMigrationError,
  runSqliteDataMigrations,
  sqliteDataMigration,
  type SqliteDataMigration,
  type SqliteDataMigrationClient,
} from "./sqlite-data-migrations";
// Shared inline-config-field → blob-table migration body; the protocol
// plugins bind their field names and export the ledger entries.
export {
  runSqliteConfigBlobMigration,
  type SqliteConfigBlobMigrationOptions,
} from "./sqlite-config-blob-migration";
export {
  authToolFailure,
  type AuthToolFailureCode,
  type AuthToolFailureInput,
} from "./auth-tool-failure";
