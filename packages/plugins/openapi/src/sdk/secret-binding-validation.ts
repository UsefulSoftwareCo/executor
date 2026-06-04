import type { ScopeId } from "@executor-js/sdk/shared";

export interface PendingSecretCredentialBinding {
  readonly slot: string;
  readonly secretId: string;
  readonly scope: ScopeId;
  readonly secretScope: ScopeId;
}

export interface AvailableSecretRef {
  readonly id: string;
  readonly scopeId: string | ScopeId;
}

const secretKey = (scopeId: string | ScopeId, secretId: string): string =>
  `${String(scopeId)}\u0000${secretId}`;

export const findMissingSecretCredentialBindings = (
  bindings: readonly PendingSecretCredentialBinding[],
  secrets: readonly AvailableSecretRef[],
): readonly PendingSecretCredentialBinding[] => {
  const available = new Set(secrets.map((secret) => secretKey(secret.scopeId, secret.id)));
  return bindings.filter(
    (binding) => !available.has(secretKey(binding.secretScope, binding.secretId)),
  );
};

export const missingSecretCredentialBindingsMessage = (
  missing: readonly PendingSecretCredentialBinding[],
): string | null => {
  if (missing.length === 0) return null;
  if (missing.length === 1) {
    return `Secret "${missing[0]!.secretId}" no longer exists in the selected credential scope. Choose an existing secret or create a new one before adding the source.`;
  }
  return `${missing.length} selected secrets no longer exist in their selected credential scopes. Choose existing secrets or create new ones before adding the source.`;
};

export const secretCredentialBindingsSubmitError = (
  bindings: readonly PendingSecretCredentialBinding[],
  secrets: readonly AvailableSecretRef[],
): string | null =>
  missingSecretCredentialBindingsMessage(findMissingSecretCredentialBindings(bindings, secrets));
