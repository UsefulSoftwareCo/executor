// ---------------------------------------------------------------------------
// @executor-js/sdk/shared — browser-safe domain contracts.
//
// This entry is for React and plugin UI code that needs runtime IDs,
// tagged errors, policy helpers, and wire contracts without importing the
// server/plugin SDK root.
// ---------------------------------------------------------------------------

export { ScopeId, ToolId, SecretId, PolicyId, ConnectionId, CredentialBindingId } from "./ids";

export {
  ToolNotFoundError,
  SourceRemovalNotAllowedError,
  SecretNotFoundError,
  SecretResolutionError,
  SecretOwnedByConnectionError,
  SecretInUseError,
  ConnectionNotFoundError,
  ConnectionInUseError,
} from "./errors";

export { InternalError } from "./api-errors";

export {
  effectivePolicyFromSorted,
  ToolPolicyActionSchema,
  type EffectivePolicy,
  type ToolPolicy,
} from "./policies";

export type { ToolPolicyAction } from "./core-schema";

export {
  SecretBackedMap,
  SecretBackedValue,
  isSecretBackedRef,
  type ResolveSecretBackedMapOptions,
} from "./secret-backed-value";

export {
  ConfiguredCredentialBinding,
  ConfiguredCredentialValue,
  CredentialBindingRef,
  CredentialBindingValue,
  CredentialBindingSlotInput,
  RemoveCredentialBindingInput,
  RemoveSourceCredentialBindingInput,
  ScopedSecretCredentialInput,
  SetSourceCredentialBindingInput,
  ReplaceCredentialBindingValue,
  ReplaceCredentialBindingsInput,
  ReplaceSourceCredentialBindingsInput,
  SourceCredentialBindingSource,
  SourceCredentialBindingSourceInput,
  SourceCredentialBindingSlotInput,
  credentialSlotKey,
  credentialSlotPart,
} from "./credential-bindings";

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

export { SourceDetectionResult, type Source } from "./types";

export { Usage } from "./usages";

export { ConnectionIdentityOverride, UpdateConnectionIdentityInput } from "./connections";

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
  type ExecutorLocalServerKind,
  type ExecutorLocalServerManifest,
  type ExecutorServerAuth,
  type ExecutorServerConnection,
  type ExecutorServerConnectionInput,
  type ExecutorServerConnectionKind,
} from "./server-connection";

export {
  OAUTH_POPUP_MESSAGE_TYPE,
  isOAuthPopupResult,
  type OAuthPopupResult,
} from "./oauth-popup-types";

export {
  OAuthProbeError,
  OAuthStartError,
  OAuthCompleteError,
  OAuthSessionNotFoundError,
  OAuthStrategy as OAuthStrategySchema,
  type OAuthStrategy,
} from "./oauth";
