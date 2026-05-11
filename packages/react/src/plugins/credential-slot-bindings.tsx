import { ScopeId, type CredentialBindingValue } from "@executor-js/sdk";

import { Button } from "../components/button";
import { CardStackEntryField } from "../components/card-stack";
import type { CredentialTargetScopeOption } from "./credential-target-scope";
import {
  effectiveCredentialBindingForScope,
  exactCredentialBindingForScope,
  isSecretCredentialBindingValue,
} from "./credential-bindings";
import { CreatableSecretPicker } from "./secret-header-auth";
import type { SecretPickerSecret } from "./secret-picker";

export type SecretCredentialSlot = {
  readonly slot: string;
  readonly label: string;
  readonly hint?: string;
};

export type CredentialBindingScope = {
  readonly scopeId: ScopeId;
  readonly label: string;
};

type CredentialSlotBindingRef = {
  readonly slot: string;
  readonly scopeId: ScopeId;
  readonly value: CredentialBindingValue;
};

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

const bindingSecretId = (sourceId: string, slot: string, scopeId: string): string =>
  `source-binding-${slugify(sourceId)}-${slugify(slot)}-${slugify(scopeId)}`;

const rowTitle = (bindingScope: CredentialBindingScope, bindingScopeCount: number): string =>
  bindingScope.label === "Personal"
    ? "My override"
    : bindingScopeCount === 1
      ? "Source credential"
      : "Organization default";

export function SecretCredentialSlotBindings(props: {
  readonly slots: readonly SecretCredentialSlot[];
  readonly bindingScopes: readonly CredentialBindingScope[];
  readonly bindingRows: readonly CredentialSlotBindingRef[];
  readonly scopeRanks: ReadonlyMap<string, number>;
  readonly secrets: readonly SecretPickerSecret[];
  readonly sourceId: string;
  readonly sourceName: string;
  readonly credentialScopeOptions: readonly CredentialTargetScopeOption[];
  readonly busyKey: string | null;
  readonly onSetSecretBinding: (
    targetScope: ScopeId,
    slot: string,
    secretId: string,
    secretScope: ScopeId,
  ) => void | Promise<void>;
  readonly onClearBinding: (targetScope: ScopeId, slot: string) => void | Promise<void>;
}) {
  return (
    <>
      {props.slots.map((slot) => (
        <CardStackEntryField key={slot.slot} label={slot.label}>
          <div className="space-y-3">
            {props.bindingScopes.map((bindingScope) => {
              const exact = exactCredentialBindingForScope(
                props.bindingRows,
                slot.slot,
                bindingScope.scopeId,
              );
              const exactSecretId =
                exact && isSecretCredentialBindingValue(exact.value) ? exact.value.secretId : null;
              const inherited =
                bindingScope.label === "Personal"
                  ? effectiveCredentialBindingForScope(
                      props.bindingRows,
                      slot.slot,
                      bindingScope.scopeId,
                      props.scopeRanks,
                    )
                  : null;
              const inheritedSecretId =
                inherited &&
                inherited.scopeId !== bindingScope.scopeId &&
                isSecretCredentialBindingValue(inherited.value)
                  ? inherited.value.secretId
                  : null;
              const inputKey = `${bindingScope.scopeId}:${slot.slot}`;
              const clearKey = `${bindingScope.scopeId}:${slot.slot}:clear`;

              return (
                <div
                  key={bindingScope.scopeId}
                  className="space-y-2 rounded-md border border-border bg-background/40 p-3"
                >
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-sm font-medium text-foreground">
                        {rowTitle(bindingScope, props.bindingScopes.length)}
                      </div>
                    </div>
                    {bindingScope.label === "Personal" && !exactSecretId && inheritedSecretId && (
                      <span className="text-xs text-muted-foreground">
                        Using organization default
                      </span>
                    )}
                  </div>
                  <CreatableSecretPicker
                    value={exactSecretId}
                    onSelect={(secretId, secretScopeId) => {
                      void props.onSetSecretBinding(
                        bindingScope.scopeId,
                        slot.slot,
                        secretId,
                        secretScopeId ?? bindingScope.scopeId,
                      );
                    }}
                    secrets={props.secrets}
                    placeholder="Select or create a secret"
                    targetScope={bindingScope.scopeId}
                    credentialScopeOptions={props.credentialScopeOptions}
                    suggestedId={bindingSecretId(props.sourceId, slot.slot, bindingScope.scopeId)}
                    sourceName={props.sourceName}
                    secretLabel={slot.label}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {exactSecretId && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void props.onClearBinding(bindingScope.scopeId, slot.slot)}
                        disabled={props.busyKey === clearKey}
                      >
                        Clear
                      </Button>
                    )}
                    {props.busyKey === inputKey && (
                      <span className="text-xs text-muted-foreground">Saving…</span>
                    )}
                    {slot.hint && (
                      <span className="text-xs text-muted-foreground">{slot.hint}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardStackEntryField>
      ))}
    </>
  );
}
