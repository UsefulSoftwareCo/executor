import type { ScopeId } from "@executor-js/sdk/shared";

import type { SecretPickerSecret } from "./secret-picker";
import type { CredentialTargetScopeOption } from "./credential-target-scope";

type ScopeStackEntryLike = {
  readonly id: ScopeId | string;
};

const scopeRank = (scopeStack: readonly ScopeStackEntryLike[], scopeId: ScopeId | string): number =>
  scopeStack.findIndex((entry) => String(entry.id) === String(scopeId));

export const secretsForCredentialTarget = (
  secrets: readonly SecretPickerSecret[],
  targetScope: ScopeId,
  scopeStack: readonly ScopeStackEntryLike[] = [],
): readonly SecretPickerSecret[] =>
  secrets.filter((secret) => {
    const targetRank = scopeRank(scopeStack, targetScope);
    if (targetRank === -1) return secret.scopeId === String(targetScope);

    const secretRank = scopeRank(scopeStack, secret.scopeId);
    return secretRank >= targetRank;
  });

export const secretScopeOptionsForCredentialTarget = (
  options: readonly CredentialTargetScopeOption[],
  targetScope: ScopeId,
  scopeStack: readonly ScopeStackEntryLike[] = [],
): readonly CredentialTargetScopeOption[] => {
  const targetRank = scopeRank(scopeStack, targetScope);
  if (targetRank === -1) {
    return options.filter((option) => option.scopeId === targetScope);
  }

  return options.filter((option) => {
    const optionRank = scopeRank(scopeStack, option.scopeId);
    return optionRank >= targetRank;
  });
};
