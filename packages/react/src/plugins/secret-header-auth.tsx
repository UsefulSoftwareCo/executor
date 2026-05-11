import { useId, useState, type ReactNode } from "react";

import { ScopeId } from "@executor-js/sdk";
import { Button } from "../components/button";
import { Field, FieldGroup, FieldLabel } from "../components/field";
import { HelpTooltip } from "../components/help-tooltip";
import { Input } from "../components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import { SecretForm } from "./secret-form";
import { SecretPicker, type SecretPickerSecret } from "./secret-picker";
import {
  CredentialTargetScopeSelector,
  type CredentialTargetScopeOption,
} from "./credential-target-scope";
import { secretsForCredentialTarget } from "./secret-credential-scope";

export { secretsForCredentialTarget };

export interface HeaderAuthPreset {
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly prefix?: string;
}

export const defaultHeaderAuthPresets: readonly HeaderAuthPreset[] = [
  {
    key: "bearer",
    label: "Bearer Token",
    name: "Authorization",
    prefix: "Bearer ",
  },
  {
    key: "basic",
    label: "Basic Auth",
    name: "Authorization",
    prefix: "Basic ",
  },
  { key: "api-key", label: "API Key", name: "X-API-Key" },
  { key: "auth-token", label: "Auth Token", name: "X-Auth-Token" },
  { key: "access-token", label: "Access Token", name: "X-Access-Token" },
  { key: "cookie", label: "Cookie", name: "Cookie" },
  { key: "custom", label: "Custom", name: "" },
];

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

export function InlineCreateSecret(props: {
  suggestedName: string;
  existingSecretIds: readonly string[];
  onCreated: (secretId: string, scopeId: ScopeId) => void;
  onCancel: () => void;
  fallbackId?: string;
  targetScope: ScopeId;
  credentialScopeOptions?: readonly CredentialTargetScopeOption[];
}) {
  return (
    <div className="bg-primary/[0.03] px-4 py-3">
      <p className="mb-3 text-[11px] font-semibold tracking-wide text-primary uppercase">
        New secret
      </p>
      <CreateSecretContent {...props} />
    </div>
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

export type SecretCredentialPreviewProps = {
  readonly name: string;
  readonly secretId: string;
  readonly prefix?: string;
};

export type SecretCredentialPreviewComponent = (props: SecretCredentialPreviewProps) => ReactNode;

export function HeaderCredentialValuePreview(props: SecretCredentialPreviewProps) {
  const { name, prefix } = props;
  const maskedValue = "•".repeat(12);

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs">
      <span className="text-muted-foreground shrink-0">{name}:</span>
      <span className="text-foreground truncate">
        {prefix && <span className="text-muted-foreground">{prefix}</span>}
        {maskedValue}
      </span>
    </div>
  );
}

export function QueryParamCredentialValuePreview(props: SecretCredentialPreviewProps) {
  const { name, prefix } = props;
  const maskedValue = "•".repeat(12);

  return (
    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs">
      <span className="text-muted-foreground">?{name}=</span>
      <span className="text-foreground">
        {prefix && <span className="text-muted-foreground">{prefix}</span>}
        {maskedValue}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header state helpers — shared by edit forms
// ---------------------------------------------------------------------------

export type HeaderState = {
  name: string;
  secretId: string | null;
  prefix?: string;
  presetKey?: string;
  fromPreset?: boolean;
  /** Scope where this source credential value is used. */
  targetScope?: ScopeId;
  /** Scope that owns the selected reusable secret. */
  secretScope?: ScopeId;
};

export function matchPresetKey(name: string, prefix?: string): string {
  const preset =
    defaultHeaderAuthPresets.find((p) => p.name === name && p.prefix === prefix) ??
    defaultHeaderAuthPresets.find((p) => p.name === name && p.prefix === undefined);
  return preset?.key ?? "custom";
}

function InfoLabel(props: { readonly children: string; readonly tooltip: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <FieldLabel>{props.children}</FieldLabel>
      <HelpTooltip label={props.children}>{props.tooltip}</HelpTooltip>
    </div>
  );
}

export type SecretCredentialRowCopy = {
  readonly rowLabel: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly prefixLabel: string;
  readonly prefixPlaceholder: string;
  readonly secretLabel: string;
  readonly secretHelp: string;
  readonly usedByLabel: string;
  readonly usedByHelp: string;
};

const defaultSecretCredentialRowCopy: SecretCredentialRowCopy = {
  rowLabel: "Header",
  nameLabel: "Name",
  namePlaceholder: "Authorization",
  prefixLabel: "Prefix",
  prefixPlaceholder: "Bearer ",
  secretLabel: "Secret",
  secretHelp: "Select or create a reusable secret.",
  usedByLabel: "Used by",
  usedByHelp: "Choose who uses this credential value.",
};

export function headerValueToState(
  name: string,
  value: { secretId: string; prefix?: string } | string,
): HeaderState {
  if (typeof value === "string") {
    return { name, secretId: null, presetKey: matchPresetKey(name, undefined) };
  }
  return {
    name,
    secretId: value.secretId,
    prefix: value.prefix,
    presetKey: matchPresetKey(name, value.prefix),
  };
}

export function headersFromState(
  entries: readonly HeaderState[],
): Record<string, { secretId: string; prefix?: string }> {
  const result: Record<string, { secretId: string; prefix?: string }> = {};
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name || !entry.secretId) continue;
    result[name] = {
      secretId: entry.secretId,
      ...(entry.prefix ? { prefix: entry.prefix } : {}),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Secret header auth row
// ---------------------------------------------------------------------------

export function SecretHeaderAuthRow(props: {
  name: string;
  prefix?: string;
  presetKey?: string;
  secretId: string | null;
  secretScope?: ScopeId;
  onChange: (update: {
    name: string;
    secretId?: string | null;
    prefix?: string;
    presetKey?: string;
    targetScope?: ScopeId;
    secretScope?: ScopeId;
  }) => void;
  onSelectSecret: (secretId: string, scopeId?: ScopeId) => void;
  existingSecrets: readonly SecretPickerSecret[];
  onRemove?: () => void;
  removeLabel?: string;
  copy?: Partial<SecretCredentialRowCopy>;
  previewComponent?: SecretCredentialPreviewComponent;
  /**
   * Display name of the source this header belongs to (e.g. "Axiom"). Used
   * to prefix the suggested secret label and ID so tokens from different
   * sources don't collide on ids like `authorization`.
   */
  sourceName?: string;
  targetScope: ScopeId;
  credentialScopeOptions?: readonly CredentialTargetScopeOption[];
  bindingScopeOptions?: readonly CredentialTargetScopeOption[];
  restrictSecretsToTargetScope?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const nameInputId = useId();
  const prefixInputId = useId();
  const {
    name,
    prefix,
    presetKey,
    secretId,
    secretScope,
    onChange,
    onSelectSecret,
    existingSecrets,
    onRemove,
    removeLabel = "Remove",
    copy: copyOverride,
    previewComponent: PreviewComponent = HeaderCredentialValuePreview,
    sourceName,
    targetScope,
    credentialScopeOptions,
    bindingScopeOptions,
    restrictSecretsToTargetScope = false,
  } = props;

  const isCustom = presetKey === "custom" || presetKey === undefined;
  const copy = { ...defaultSecretCredentialRowCopy, ...copyOverride };
  const headerLabel = name.trim() || "Custom Header";
  const suggestedName = [sourceName?.trim(), headerLabel].filter(Boolean).join(" ");
  const scopedSecrets = secretsForCredentialTarget(existingSecrets, targetScope);
  const selectableSecrets = restrictSecretsToTargetScope ? scopedSecrets : existingSecrets;

  return (
    <div className="space-y-2.5 px-4 py-3">
      <CreateSecretDialog
        open={creating}
        onOpenChange={setCreating}
        suggestedName={suggestedName}
        existingSecretIds={scopedSecrets.map((secret) => secret.id)}
        onCreated={(id, scopeId) => {
          onSelectSecret(id, scopeId);
          setCreating(false);
        }}
        targetScope={targetScope}
        credentialScopeOptions={credentialScopeOptions}
      />
      <div className="flex w-full items-center justify-between gap-4">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {copy.rowLabel}
        </span>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            {removeLabel}
          </Button>
        )}
      </div>

      <FieldGroup className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor={nameInputId}>{copy.nameLabel}</FieldLabel>
          <Input
            id={nameInputId}
            value={name}
            onChange={(e) =>
              onChange({
                name: (e.target as HTMLInputElement).value,
                prefix,
                presetKey: isCustom ? "custom" : presetKey,
              })
            }
            placeholder={copy.namePlaceholder}
            className="font-mono"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={prefixInputId}>
            {copy.prefixLabel}{" "}
            <span className="font-normal text-muted-foreground/60">(optional)</span>
          </FieldLabel>
          <Input
            id={prefixInputId}
            value={prefix ?? ""}
            onChange={(e) =>
              onChange({
                name,
                prefix: (e.target as HTMLInputElement).value || undefined,
                presetKey: isCustom ? "custom" : presetKey,
              })
            }
            placeholder={copy.prefixPlaceholder}
            className="font-mono"
          />
        </Field>
      </FieldGroup>

      <div
        className={
          bindingScopeOptions && bindingScopeOptions.length > 1
            ? "grid gap-2 md:grid-cols-2"
            : undefined
        }
      >
        <div className="space-y-1.5">
          <InfoLabel tooltip={copy.secretHelp}>{copy.secretLabel}</InfoLabel>
          <SecretPicker
            value={secretId}
            valueScopeId={secretScope ? String(secretScope) : undefined}
            onSelect={(id, scopeId) => onSelectSecret(id, ScopeId.make(scopeId))}
            secrets={selectableSecrets}
            onCreateNew={() => setCreating(true)}
          />
        </div>
        {bindingScopeOptions && bindingScopeOptions.length > 1 && (
          <div className="space-y-1.5">
            <InfoLabel tooltip={copy.usedByHelp}>{copy.usedByLabel}</InfoLabel>
            <Select
              value={String(targetScope)}
              onValueChange={(nextScope) =>
                onChange({
                  name,
                  secretId: null,
                  secretScope: undefined,
                  prefix,
                  presetKey,
                  targetScope: ScopeId.make(nextScope),
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Used by" />
              </SelectTrigger>
              <SelectContent>
                {bindingScopeOptions.map((option) => (
                  <SelectItem key={option.scopeId} value={option.scopeId}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {secretId && name.trim() && (
        <PreviewComponent name={name.trim()} secretId={secretId} prefix={prefix} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreatableSecretPicker — SecretPicker + inline "+ New secret" create flow
// ---------------------------------------------------------------------------

export function CreatableSecretPicker(props: {
  readonly value: string | null;
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
      valueScopeId={String(targetScope)}
      onSelect={(id, scopeId) => onSelect(id, ScopeId.make(scopeId))}
      secrets={secrets}
      placeholder={placeholder}
      onCreateNew={() => setCreating(true)}
    />
  );
}
