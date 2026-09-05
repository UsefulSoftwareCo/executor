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
export {
  CredentialWriteIncompleteError,
  StorageError,
  StorageConnectionError,
  UniqueViolationError,
  isStorageFailure,
} from "./fuma-runtime";

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
  ArtifactId,
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
  OrgWriteDeniedError,
  ConnectionAlreadyExistsError,
  ConnectionNotFoundError,
  CredentialProviderNotRegisteredError,
  CredentialResolutionError,
  ArtifactNotFoundError,
  isUserActionableError,
  type ExecuteError,
  type ExecutorError,
  type UserActionableError,
} from "./errors";

// Integration / connection / tool domain contracts.
export type {
  AuthMethodDescriptor,
  AuthMethodOAuthDescriptor,
  AuthPlacementDescriptor,
  Integration,
  IntegrationChangeEvent,
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
  ValidateConnectionInput,
} from "./connection";
export type { Tool, ToolDef, ToolListFilter, ToolAnnotations } from "./tool";
// Credential providers.
export type { CredentialProvider, ProviderEntry } from "./provider";

// Public projections / detection.
export { ToolSchemaView, ToolProjection, IntegrationDetectionResult } from "./types";

// Health-check vocabulary (pure Schema + helpers).
export {
  HealthStatus,
  HealthCheckReason,
  HealthCheckSpec,
  HealthCheckResult,
  HealthCheckResponseSample,
  HealthCheckCandidate,
  HealthCheckCandidateParameter,
  HealthCheckResponseField,
  classifyHttpStatus,
  classifyProbeResponse,
  extractIdentity,
  compareHealthCheckCandidates,
  candidateIdentityTier,
  sortHealthCheckCandidatesByIdentity,
  projectResponseFields,
  extractResponseFields,
  pathNamesASecret,
  REDACTED_SAMPLE_VALUE,
  identityPathTier,
  rankResponseSample,
} from "./health-check";

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
  type SubjectRow,
  type ConnectionRow,
  type OAuthClientRow,
  type OAuthSessionRow,
  type ToolRow,
  type ToolInvocationRow,
  type DefinitionRow,
  type ToolPolicyRow,
  type ArtifactRow,
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
  type ExecutorReach,
  type ExecutorWrites,
} from "./owner-policy";

// Provider item-id owner grammar — the partition credential providers file
// rows under (issues #950, #1453).
export {
  OWNER_SCOPED_ITEM_ID_PREFIXES,
  embeddedItemOwner,
  ownerForItemId,
} from "./provider-item-owner";

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

// Artifacts — saved generative-UI components.
export {
  rowToArtifact,
  rowToArtifactSummary,
  previewFromColumn,
  ArtifactBinding,
  ArtifactBindings,
  type Artifact,
  type ArtifactPreview,
  type ArtifactSummary,
  type SaveArtifactInput,
  type RenameArtifactInput,
  type RemoveArtifactInput,
  type SetArtifactPreviewInput,
} from "./artifact";
export { sanitizeArtifactPreviewMarkup, ARTIFACT_PREVIEW_MARKUP_LIMIT } from "./artifact-preview";

// Elicitation.
export {
  ElicitationMeta,
  FormElicitation,
  UrlElicitation,
  ElicitationAction,
  ElicitationResponse,
  ElicitationDeclinedError,
  type ElicitationRequest,
  type ElicitationHandler,
  type ElicitationContext,
  type ElicitationSource,
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

// Durable pending approvals — how an artifact action that paused on a human
// survives a host whose HTTP API builds a fresh engine per request.
export {
  makePendingApprovalStore,
  PendingApproval,
  PENDING_APPROVAL_TTL_MS,
  type PendingApprovalStore,
} from "./pending-approval";

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
export {
  OAUTH2_PROVIDER_KEY,
  OAUTH2_SESSION_TTL_MS,
  decodeOAuthCallbackState,
  encodeOAuthCallbackState,
  type OAuthCallbackState,
} from "./oauth";
export {
  OAuthStartError,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthRegisterDynamicError,
  OAuthSessionNotFoundError,
  FIRST_PARTY_OAUTH_CLIENT_PREFIX,
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
  firstPartyOAuthClientSlug,
  isFirstPartyOAuthClientSlug,
  type FirstPartyOAuthClientConfig,
  type OAuthClientOrigin,
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

// The enterprise-managed rollout PORT (not its implementation): hosts that
// operate a feature-flag service implement this and hand it to
// `createExecutor`. Core depends on no vendor.
export {
  ENTERPRISE_MANAGED_ROLLOUT_ENABLED,
  type EnterpriseManagedRollout,
  type EnterpriseManagedRolloutContext,
  type EnterpriseManagedRolloutDecision,
  type EnterpriseManagedRolloutEvent,
  type EnterpriseManagedRolloutWithheldReason,
} from "./oauth-ema";

// NOTE: the OAuth 2.1 implementation helpers (`./oauth-helpers`,
// `makeOAuthService` in `./oauth-service`, discovery in `./oauth-discovery`)
// are SDK-internal — consumed only by `createExecutor`. The hosted HTTP client
// builder is host-internal and reachable via `@executor-js/sdk/host-internal`.

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
  resolveExecutorServerConfiguredHeaders,
  resolveExecutorServerRequestHeaders,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
  type ExecutorServerConnectionKind,
  type ExecutorServerHeaders,
  type ExecutorServerHeaderValue,
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
  type ToolPolicyProvider,
  type ToolPolicyProviderRule,
  type PreparedToolPolicy,
  type IntegrationRecord,
  type StaticIntegrationDecl,
  type StaticToolDecl,
  type StaticToolSchema,
  type StaticToolExecuteContext,
  type StaticToolHandlerInput,
  type StaticToolInput,
  type ConfigureIntegrationHandlerInput,
  type InvokeToolInput,
  type ValidateToolArgsInput,
  type ConnectionLifecycleInput,
  type IntegrationConfigureDecl,
  type IntegrationConfigureSchema,
  type IntegrationPreset,
  type IntegrationPresetAuthentication,
  type IntegrationPresetCatalogEntry,
  type ResolveToolsInput,
  type ResolveToolsResult,
  type ToolInvocationCredential,
  type HealthCheckInput,
  type HealthCheckCandidatesInput,
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
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
  type AdminConnection,
  type AdminListSubjectsOptions,
  type AdminSubject,
  type AdminSubjectWithConnections,
  type Executor,
  type ExecutorAdmin,
  type ExecutorConfig,
  type ExecutorDb,
  type ExecutorDbFactory,
  type ExecutorDbInput,
  type ParsedToolAddress,
  DEFAULT_TOOLS_SYNC_GRACE_MS,
  STALE_TOOLS_SYNC_CONCURRENCY,
  createExecutor,
  collectTables,
  parseToolAddress,
  connectionAddress,
  toolAddress,
} from "./executor";
export {
  CurrentOrgWriteAccess,
  currentOrgWriteAccess,
  makeOrgWriteAccessState,
  type OrgWriteAccess,
  type OrgWriteAccessState,
} from "./org-write-access";

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
  ToolFileSchema,
  ToolFileJsonSchema,
  ToolResult,
  annotateToolResultOutcome,
  isToolFile,
  isToolResult,
  type ToolFile,
  type ToolFile as ToolFileValue,
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
// DCR oauth_client GC + issuer backfill: shared classification predicates and
// the libSQL boot-migration body (issue #1120, Part C).
export {
  classifyOAuthClientGc,
  isDcrClassifiedRow,
  registrableOriginOfUrl,
  type OAuthClientGcDecision,
  type OAuthClientGcRow,
} from "./oauth-gc";
export {
  oauthClientGcSqliteMigration,
  runSqliteOAuthClientGcMigration,
} from "./sqlite-oauth-client-gc-migration";
// Rewrite `bigint` columns an earlier build left in SQLite's INTEGER storage
// class, which the bigint row mapper cannot read (issue #1771).
export {
  bigintStorageClassSqliteMigration,
  runSqliteBigintStorageClassMigration,
  LEGACY_BIGINT_STORAGE_CLASS_COLUMNS,
  type BigintStorageClassColumn,
} from "./sqlite-bigint-storage-class-migration";
export {
  authToolFailure,
  isUnauthorizedToolFailure,
  type AuthToolFailureCode,
  type AuthToolFailureInput,
} from "./auth-tool-failure";
export {
  detectInsufficientScope,
  insufficientScopeFromEmbeddedJson,
  type InsufficientScopeDetection,
} from "./insufficient-scope";

// Endpoint sanitization for span attributes — plugins stamping a user-supplied
// endpoint must strip its credential-bearing parts first.
export { endpointForTelemetry, endpointTelemetryAttributes } from "./telemetry-endpoint";

// URL redaction for exported telemetry — the shared scrub every exporter path
// (cloud span processors, self-host and browser OTLP serialization, the
// browser-traces forwarder) consumes.
export {
  redactOtlpTraceExport,
  redactSpanUrlAttributes,
  redactStringElements,
  redactUrlForTelemetry,
  redactUrlsInText,
  STRIPPED_QUERY_ATTRIBUTE,
  UrlRedactingOtlpSerializationJson,
  type RedactedUrl,
} from "./telemetry-url-redaction";
