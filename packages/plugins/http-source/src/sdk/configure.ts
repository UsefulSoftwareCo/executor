import {
  ConnectionId,
  ConfiguredCredentialBinding,
  type ConfiguredCredentialValue,
  type CredentialBindingValue,
  type ScopedSecretCredentialInput,
  SecretId,
  ScopeId,
} from "@executor-js/sdk/shared";

import type { HttpCredentialInput } from "./types";

export type HttpNamedCredentialInput =
  | ConfiguredCredentialValue
  | ScopedSecretCredentialInput
  | {
      readonly secretId: string;
      readonly prefix?: string;
      readonly targetScope?: string;
      readonly secretScopeId?: string;
    };

export interface CompiledHttpNamedCredentialBinding {
  readonly slot: string;
  readonly value: CredentialBindingValue;
  readonly targetScope?: string;
}

export const compileHttpNamedCredentialMap = (
  values: Record<string, HttpNamedCredentialInput | HttpCredentialInput> | undefined,
  slotForName: (name: string) => string,
): {
  readonly values: Record<string, ConfiguredCredentialValue>;
  readonly bindings: readonly CompiledHttpNamedCredentialBinding[];
} => {
  const nextValues: Record<string, ConfiguredCredentialValue> = {};
  const bindings: CompiledHttpNamedCredentialBinding[] = [];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (typeof value === "string") {
      nextValues[name] = value;
      continue;
    }
    if ("kind" in value) {
      if (value.kind === "binding") {
        nextValues[name] = value;
        continue;
      }
      const slot = slotForName(name);
      nextValues[name] = ConfiguredCredentialBinding.make({
        kind: "binding",
        slot,
        prefix: "prefix" in value ? value.prefix : undefined,
      });
      bindings.push({
        slot,
        value: httpCredentialInputToBindingValue(value),
      });
      continue;
    }
    const slot = slotForName(name);
    nextValues[name] = ConfiguredCredentialBinding.make({
      kind: "binding",
      slot,
      prefix: value.prefix,
    });
    bindings.push({
      slot,
      targetScope: "targetScope" in value ? value.targetScope : undefined,
      value: {
        kind: "secret",
        secretId: SecretId.make(value.secretId),
        ...("secretScopeId" in value && value.secretScopeId
          ? { secretScopeId: ScopeId.make(value.secretScopeId) }
          : {}),
      },
    });
  }
  return { values: nextValues, bindings };
};

export const httpCredentialInputToBindingValue = (
  input: HttpCredentialInput,
): CredentialBindingValue => {
  if (typeof input === "string") {
    return {
      kind: "text",
      text: input,
    };
  }
  if (input.kind === "text") {
    return {
      kind: "text",
      text: input.text,
    };
  }
  if (input.kind === "secret") {
    return {
      kind: "secret",
      secretId: SecretId.make(input.secretId),
      ...(input.secretScope ? { secretScopeId: ScopeId.make(input.secretScope) } : {}),
    };
  }
  if (input.kind === "connection") {
    return {
      kind: "connection",
      connectionId: ConnectionId.make(input.connectionId),
    };
  }
  return input;
};
