import { useState } from "react";

import { ScopeId } from "@executor-js/sdk";
import { Button } from "../components/button";
import { FieldGroup } from "../components/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import { SecretForm } from "./secret-form";
import { SecretPicker, type SecretPickerSecret } from "./secret-picker";
import {
  CredentialTargetScopeSelector,
  type CredentialTargetScopeOption,
} from "./credential-target-scope";
import { secretsForCredentialTarget } from "./secret-credential-scope";

function CreateSecretContent(props: {
  suggestedName: string;
  existingSecretIds: readonly string[];
  onCreated: (secretId: string, scopeId: ScopeId) => void;
  onCancel?: () => void;
  fallbackId?: string;
  targetScope: ScopeId;
  credentialScopeOptions?: readonly CredentialTargetScopeOption[];
}) {
  const [scopeId, setScopeId] = useState(props.targetScope);
  const activeScope = props.credentialScopeOptions?.find((option) => option.scopeId === scopeId);

  return (
    <SecretForm.Provider
      existingSecretIds={props.existingSecretIds}
      suggestedName={props.suggestedName}
      fallbackId={props.fallbackId ?? "custom-header"}
      scopeId={scopeId}
      onCreated={(secretId) => props.onCreated(secretId, scopeId)}
    >
      <div className="space-y-3">
        {props.credentialScopeOptions && props.credentialScopeOptions.length > 1 && (
          <CredentialTargetScopeSelector
            value={scopeId}
            options={props.credentialScopeOptions}
            onChange={setScopeId}
            title="Save secret to"
            description={activeScope?.description ?? "Choose where this secret is saved."}
          />
        )}
        <FieldGroup className="gap-3">
          <div className="grid grid-cols-2 gap-3">
            <SecretForm.NameField label="Label" placeholder="API Token" />
            <SecretForm.IdField placeholder="my-api-token" />
          </div>
          <SecretForm.ValueField revealable autoFocus placeholder="paste your token or key…" />
        </FieldGroup>
        <div className="flex justify-end gap-2 pt-0.5">
          {props.onCancel && (
            <Button type="button" variant="outline" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
          )}
          <SecretForm.SubmitButton size="sm">Create and use</SecretForm.SubmitButton>
        </div>
      </div>
    </SecretForm.Provider>
  );
}

function CreateSecretDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly suggestedName: string;
  readonly existingSecretIds: readonly string[];
  readonly onCreated: (secretId: string, scopeId: ScopeId) => void;
  readonly fallbackId?: string;
  readonly targetScope: ScopeId;
  readonly credentialScopeOptions?: readonly CredentialTargetScopeOption[];
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New secret</DialogTitle>
          <DialogDescription>
            Create a reusable secret, then use it for this credential.
          </DialogDescription>
        </DialogHeader>
        <CreateSecretContent
          suggestedName={props.suggestedName}
          existingSecretIds={props.existingSecretIds}
          fallbackId={props.fallbackId}
          onCreated={props.onCreated}
          onCancel={() => props.onOpenChange(false)}
          targetScope={props.targetScope}
          credentialScopeOptions={props.credentialScopeOptions}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// CreatableSecretPicker — SecretPicker + inline "+ New secret" create flow
// ---------------------------------------------------------------------------

export function CreatableSecretPicker(props: {
  readonly value: string | null;
  readonly valueScope?: ScopeId;
  readonly onSelect: (secretId: string, scopeId?: ScopeId) => void;
  readonly secrets: readonly SecretPickerSecret[];
  readonly placeholder?: string;
  readonly targetScope: ScopeId;
  readonly credentialScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly onCreatedScope?: (scopeId: ScopeId) => void;
  readonly suggestedId?: string;
  /**
   * Display name of the source the secret belongs to (e.g. "Stripe").
   * Combined with `secretLabel` to produce a suggested name/ID.
   */
  readonly sourceName?: string;
  /** Role of this secret (e.g. "Client ID", "API Token"). */
  readonly secretLabel: string;
}) {
  const {
    value,
    valueScope,
    onSelect,
    secrets,
    placeholder,
    sourceName,
    secretLabel,
    targetScope,
    credentialScopeOptions,
    onCreatedScope,
    suggestedId: suggestedIdProp,
  } = props;
  const [creating, setCreating] = useState(false);

  const suggestedName = [sourceName?.trim(), secretLabel].filter(Boolean).join(" ");
  const scopedSecrets = secretsForCredentialTarget(secrets, targetScope);

  if (creating) {
    return (
      <CreateSecretDialog
        open={creating}
        onOpenChange={setCreating}
        suggestedName={suggestedName}
        existingSecretIds={scopedSecrets.map((secret) => secret.id)}
        fallbackId={suggestedIdProp?.trim() || "secret"}
        onCreated={(id, scopeId) => {
          onCreatedScope?.(scopeId);
          onSelect(id, scopeId);
          setCreating(false);
        }}
        targetScope={targetScope}
        credentialScopeOptions={credentialScopeOptions}
      />
    );
  }

  return (
    <SecretPicker
      value={value}
      valueScopeId={String(valueScope ?? targetScope)}
      onSelect={(id, scopeId) => onSelect(id, ScopeId.make(scopeId))}
      secrets={secrets}
      placeholder={placeholder}
      onCreateNew={() => setCreating(true)}
    />
  );
}
