import {
  ScopeId,
  type CredentialBindingValue,
  type SecretBackedValue,
} from "@executor-js/sdk/shared";

export type ConfiguredCredentialValueLike =
  | string
  | {
      readonly slot: string;
      readonly prefix?: string;
    };

export type CredentialBindingRefLike = {
  readonly slotKey: string;
  readonly scopeId: ScopeId;
  readonly value: CredentialBindingValue;
};

const bindingBySlot = (
  bindings: readonly CredentialBindingRefLike[],
): ReadonlyMap<string, CredentialBindingRefLike> =>
  new Map(bindings.map((binding) => [binding.slotKey, binding]));

export const initialCredentialTargetScope = (
  sourceScope: ScopeId,
  bindings: readonly CredentialBindingRefLike[],
): ScopeId => bindings[0]?.scopeId ?? sourceScope;

export const exactCredentialBindingForScope = (
  rows: readonly CredentialBindingRefLike[],
  slot: string,
  scopeId: ScopeId,
): CredentialBindingRefLike | null =>
  rows.find((row) => row.slotKey === slot && row.scopeId === scopeId) ?? null;

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: ScopeId): number =>
  ranks.get(scopeId) ?? Number.MAX_SAFE_INTEGER;

export const effectiveCredentialBindingForScope = (
  rows: readonly CredentialBindingRefLike[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
): CredentialBindingRefLike | null =>
  rows.find(
    (row) => row.slotKey === slot && scopeRank(ranks, row.scopeId) >= scopeRank(ranks, targetScope),
  ) ?? null;

export const isSecretCredentialBindingValue = (
  value: CredentialBindingValue,
): value is Extract<CredentialBindingValue, { readonly kind: "secret" }> => value.kind === "secret";

export const isConnectionCredentialBindingValue = (
  value: CredentialBindingValue,
): value is Extract<CredentialBindingValue, { readonly kind: "connection" }> =>
  value.kind === "connection";

export const secretBackedValuesFromConfiguredCredentialBindings = (
  values: Record<string, ConfiguredCredentialValueLike> | undefined | null,
  bindingsInput: readonly CredentialBindingRefLike[],
): Record<string, SecretBackedValue> | undefined => {
  const bindings = bindingBySlot(bindingsInput);
  const out: Record<string, SecretBackedValue> = {};

  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      out[name] = value;
      continue;
    }

    const binding = bindings.get(value.slot);
    if (binding?.value.kind === "secret") {
      out[name] = {
        secretId: binding.value.secretId,
        ...(value.prefix ? { prefix: value.prefix } : {}),
      };
    } else if (binding?.value.kind === "text") {
      out[name] = binding.value.text;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
};
