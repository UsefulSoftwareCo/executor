import type { ScopeId } from "@executor-js/sdk";

import type { SecretPickerSecret } from "./secret-picker";

export const secretsForCredentialTarget = (
  secrets: readonly SecretPickerSecret[],
  targetScope: ScopeId,
): readonly SecretPickerSecret[] =>
  secrets.filter((secret) => secret.scopeId === String(targetScope));
