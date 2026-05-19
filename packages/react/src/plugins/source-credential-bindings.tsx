import { useMemo, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";

import {
  RemoveSourceCredentialBindingInput,
  ScopeId,
  SecretId,
  SetSourceCredentialBindingInput,
} from "@executor-js/sdk/shared";

import { removeSourceCredentialBinding, setSourceCredentialBinding } from "../api/atoms";
import { sourceWriteKeys } from "../api/reactivity-keys";
import { useScopeStack, useUserScope } from "../api/scope-context";
import type { CredentialBindingRefLike } from "./credential-bindings";
import type { CredentialBindingScope } from "./credential-slot-bindings";
import type { CredentialTargetScopeOption } from "./credential-target-scope";

export function useSourceCredentialBindingScopes(input: { readonly sourceScope: ScopeId }): {
  readonly credentialScopes: readonly CredentialBindingScope[];
  readonly credentialScopeOptions: readonly CredentialTargetScopeOption[];
  readonly organizationCredentialScope: CredentialBindingScope;
  readonly personalCredentialScope: CredentialBindingScope | null;
  readonly secretBindingScopes: readonly CredentialBindingScope[];
  readonly scopeRanks: ReadonlyMap<string, number>;
} {
  const userScope = useUserScope();
  const scopeStack = useScopeStack();

  const credentialScopes = useMemo<readonly CredentialBindingScope[]>(() => {
    const entries: CredentialBindingScope[] = [];
    if (userScope !== input.sourceScope) {
      entries.push({ scopeId: ScopeId.make(userScope), label: "Personal" });
    }
    entries.push({
      scopeId: input.sourceScope,
      label: userScope === input.sourceScope ? "Credentials" : "Organization",
    });
    return entries;
  }, [input.sourceScope, userScope]);

  const credentialScopeOptions = useMemo(
    () =>
      credentialScopes.map((entry) => ({
        scopeId: entry.scopeId,
        label: entry.label,
        description:
          entry.label === "Personal"
            ? "Saved only for your account."
            : "Shared with everyone who can use this source.",
      })),
    [credentialScopes],
  );

  const organizationCredentialScope = credentialScopes[credentialScopes.length - 1]!;
  const personalCredentialScope =
    credentialScopes.find((entry) => entry.label === "Personal") ?? null;
  const secretBindingScopes =
    personalCredentialScope &&
    personalCredentialScope.scopeId !== organizationCredentialScope.scopeId
      ? [organizationCredentialScope, personalCredentialScope]
      : [organizationCredentialScope];
  const scopeRanks = useMemo(
    () => new Map(scopeStack.map((scope, index) => [scope.id, index] as const)),
    [scopeStack],
  );

  return {
    credentialScopes,
    credentialScopeOptions,
    organizationCredentialScope,
    personalCredentialScope,
    secretBindingScopes,
    scopeRanks,
  };
}

export const initialSourceCredentialScope = (
  sourceScope: ScopeId,
  bindings: readonly CredentialBindingRefLike[],
): ScopeId => bindings[0]?.scopeId ?? sourceScope;

export function useSourceCredentialBindingWriter(input: {
  readonly displayScope: ScopeId;
  readonly source: {
    readonly id: string;
    readonly scope: ScopeId;
  };
  readonly onError: (message: string | null) => void;
  readonly errorMessageFromExit?: (exit: Exit.Exit<unknown, unknown>, fallback: string) => string;
}): {
  readonly busyKey: string | null;
  readonly setSecretBinding: (
    targetScope: ScopeId,
    slot: string,
    secretId: string,
    secretScope: ScopeId,
  ) => Promise<void>;
  readonly clearBinding: (targetScope: ScopeId, slot: string) => Promise<void>;
} {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const setBinding = useAtomSet(setSourceCredentialBinding, { mode: "promiseExit" });
  const removeBinding = useAtomSet(removeSourceCredentialBinding, { mode: "promiseExit" });
  const errorMessage =
    input.errorMessageFromExit ??
    ((_exit: Exit.Exit<unknown, unknown>, fallback: string) => fallback);

  const setSecretBinding = async (
    targetScope: ScopeId,
    slot: string,
    secretId: string,
    secretScope: ScopeId,
  ) => {
    const inputKey = `${targetScope}:${slot}`;
    const trimmed = secretId.trim();
    if (!trimmed) return;
    setBusyKey(inputKey);
    input.onError(null);
    const exit = await setBinding({
      params: { scopeId: input.displayScope },
      payload: SetSourceCredentialBindingInput.make({
        source: input.source,
        scope: targetScope,
        slotKey: slot,
        value: {
          kind: "secret",
          secretId: SecretId.make(trimmed),
          secretScopeId: secretScope,
        },
      }),
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      input.onError(errorMessage(exit, "Failed to save credential binding"));
    }
    setBusyKey(null);
  };

  const clearBinding = async (targetScope: ScopeId, slot: string) => {
    setBusyKey(`${targetScope}:${slot}:clear`);
    input.onError(null);
    const exit = await removeBinding({
      params: { scopeId: input.displayScope },
      payload: RemoveSourceCredentialBindingInput.make({
        source: input.source,
        scope: targetScope,
        slotKey: slot,
      }),
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      input.onError(errorMessage(exit, "Failed to clear credential binding"));
    }
    setBusyKey(null);
  };

  return { busyKey, setSecretBinding, clearBinding };
}
