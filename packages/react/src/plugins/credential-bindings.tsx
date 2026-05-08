import { ScopeId, type CredentialBindingValue, type SecretBackedValue } from "@executor-js/sdk";

import type { HttpCredentialsState, QueryParamState } from "./http-credentials";
import { headerValueToState, type HeaderState } from "./secret-header-auth";

type ConfiguredCredentialValueLike =
  | string
  | {
      readonly slot: string;
      readonly prefix?: string;
    };

type CredentialBindingRefLike = {
  readonly slot: string;
  readonly scopeId: ScopeId;
  readonly value: CredentialBindingValue;
};

const bindingBySlot = (
  bindings: readonly CredentialBindingRefLike[],
): ReadonlyMap<string, CredentialBindingRefLike> =>
  new Map(bindings.map((binding) => [binding.slot, binding]));

export const initialCredentialTargetScope = (
  sourceScope: ScopeId,
  bindings: readonly CredentialBindingRefLike[],
): ScopeId => bindings[0]?.scopeId ?? sourceScope;

export const exactCredentialBindingForScope = (
  rows: readonly CredentialBindingRefLike[],
  slot: string,
  scopeId: ScopeId,
): CredentialBindingRefLike | null =>
  rows.find((row) => row.slot === slot && row.scopeId === scopeId) ?? null;

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: ScopeId): number =>
  ranks.get(scopeId) ?? Number.MAX_SAFE_INTEGER;

export const effectiveCredentialBindingForScope = (
  rows: readonly CredentialBindingRefLike[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
): CredentialBindingRefLike | null =>
  rows.find(
    (row) => row.slot === slot && scopeRank(ranks, row.scopeId) >= scopeRank(ranks, targetScope),
  ) ?? null;

export const isSecretCredentialBindingValue = (
  value: CredentialBindingValue,
): value is Extract<CredentialBindingValue, { readonly kind: "secret" }> => value.kind === "secret";

export const isConnectionCredentialBindingValue = (
  value: CredentialBindingValue,
): value is Extract<CredentialBindingValue, { readonly kind: "connection" }> =>
  value.kind === "connection";

const headerFromConfiguredCredential = (
  name: string,
  value: ConfiguredCredentialValueLike,
  bindings: ReadonlyMap<string, CredentialBindingRefLike>,
): HeaderState | null => {
  if (typeof value === "string") {
    return headerValueToState(name, value);
  }

  const binding = bindings.get(value.slot);
  if (binding?.value.kind === "secret") {
    return {
      ...headerValueToState(name, {
        secretId: binding.value.secretId,
        prefix: value.prefix,
      }),
      targetScope: binding.scopeId,
      secretScope: binding.value.secretScopeId,
    };
  }

  if (binding?.value.kind === "text") {
    return headerValueToState(name, binding.value.text);
  }

  return null;
};

const queryParamFromConfiguredCredential = (
  name: string,
  value: ConfiguredCredentialValueLike,
  bindings: ReadonlyMap<string, CredentialBindingRefLike>,
): QueryParamState | null => {
  if (typeof value === "string") {
    return { name, secretId: null, literalValue: value };
  }

  const binding = bindings.get(value.slot);
  if (binding?.value.kind === "secret") {
    return {
      name,
      secretId: binding.value.secretId,
      prefix: value.prefix,
      targetScope: binding.scopeId,
      secretScope: binding.value.secretScopeId,
    };
  }

  if (binding?.value.kind === "text") {
    return { name, secretId: null, literalValue: binding.value.text };
  }

  return null;
};

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

export const httpCredentialsFromConfiguredCredentialBindings = (input: {
  readonly headers?: Record<string, ConfiguredCredentialValueLike> | null;
  readonly queryParams?: Record<string, ConfiguredCredentialValueLike> | null;
  readonly bindings: readonly CredentialBindingRefLike[];
}): HttpCredentialsState => {
  const bindings = bindingBySlot(input.bindings);

  return {
    headers: Object.entries(input.headers ?? {}).flatMap(([name, value]) => {
      const state = headerFromConfiguredCredential(name, value, bindings);
      return state ? [state] : [];
    }),
    queryParams: Object.entries(input.queryParams ?? {}).flatMap(([name, value]) => {
      const state = queryParamFromConfiguredCredential(name, value, bindings);
      return state ? [state] : [];
    }),
  };
};
