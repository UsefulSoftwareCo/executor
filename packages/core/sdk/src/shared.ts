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
  pluginStorageId,
  type PluginStorageEntry,
  type PluginStorageFacade,
  type PluginStorageKeyInput,
  type PluginStorageListInput,
  type PluginStoragePutInput,
  type PluginStorageScopedKeyInput,
} from "./plugin-storage";

export { SourceDetectionResult, type Source } from "./types";

export { Usage } from "./usages";

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
