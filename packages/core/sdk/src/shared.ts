// ---------------------------------------------------------------------------
// @executor-js/sdk/shared — browser-safe domain contracts.
//
// This entry is for React and plugin UI code that needs runtime IDs,
// tagged errors, policy helpers, and wire contracts without importing the
// server/plugin SDK root.
// ---------------------------------------------------------------------------

export { ScopeId, ToolId, SecretId, PolicyId, ConnectionId, CredentialBindingId } from "./ids";

export { SecretInUseError, ConnectionInUseError } from "./errors";

export {
  effectivePolicyFromSorted,
  ToolPolicyActionSchema,
  type EffectivePolicy,
  type ToolPolicy,
} from "./policies";

export type { ToolPolicyAction } from "./core-schema";

export {
  SecretBackedValue,
  isSecretBackedRef,
  type ResolveSecretBackedMapOptions,
} from "./secret-backed-value";

export { CredentialBindingValue, ScopedSecretCredentialInput } from "./credential-bindings";

export { SourceDetectionResult, type Source } from "./types";

export {
  OAUTH_POPUP_MESSAGE_TYPE,
  isOAuthPopupResult,
  type OAuthPopupResult,
} from "./oauth-popup-types";

export type { OAuthStrategy } from "./oauth";
