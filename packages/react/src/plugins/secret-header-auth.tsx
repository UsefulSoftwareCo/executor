import { useEffect, useId, useMemo, useState, type ReactNode } from "react";

import { ScopeId } from "@executor-js/sdk/shared";
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
import { useScopeStack } from "../api/scope-context";
import { SecretForm } from "./secret-form";
import { SecretPicker, type SecretPickerSecret } from "./secret-picker";
import type { CredentialTargetScopeOption } from "./credential-target-scope";
import {
  secretsForCredentialTarget,
  secretScopeOptionsForCredentialTarget,
} from "./secret-credential-scope";

export { secretsForCredentialTarget };

export interface HeaderAuthPreset {
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly prefix?: string;
  readonly valueKind?: HeaderValueKind;
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
  secretScopeOptions?: readonly CredentialTargetScopeOption[];
  onTargetScopeChange?: (scopeId: ScopeId) => void;
}) {
  return (
    <SecretForm.Provider
      key={String(props.targetScope)}
      existingSecretIds={props.existingSecretIds}
      suggestedName={props.suggestedName}
      fallbackId={props.fallbackId ?? "custom-header"}
      scopeId={props.targetScope}
      onCreated={(secretId) => props.onCreated(secretId, props.targetScope)}
    >
      <div className="space-y-3">
        <FieldGroup className="gap-3">
          {props.secretScopeOptions && props.secretScopeOptions.length > 1 && (
            <Field>
              <FieldLabel>Save in</FieldLabel>
              <Select
                value={String(props.targetScope)}
                onValueChange={(scopeId) => props.onTargetScopeChange?.(ScopeId.make(scopeId))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Save in" />
                </SelectTrigger>
                <SelectContent>
                  {props.secretScopeOptions.map((option) => (
                    <SelectItem key={option.scopeId} value={option.scopeId}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
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
  readonly existingSecrets: readonly SecretPickerSecret[];
  readonly onCreated: (secretId: string, scopeId: ScopeId) => void;
  readonly fallbackId?: string;
  readonly targetScope: ScopeId;
  readonly secretScopeOptions?: readonly CredentialTargetScopeOption[];
}) {
  const [selectedScope, setSelectedScope] = useState(props.targetScope);
  const allowedScopeOptions = props.secretScopeOptions?.length
    ? props.secretScopeOptions
    : [
        {
          scopeId: props.targetScope,
          label: "Current",
          description: "Saved for this credential.",
        },
      ];
  const selectedExistingSecretIds = useMemo(
    () =>
      props.existingSecrets
        .filter((secret) => secret.scopeId === String(selectedScope))
        .map((secret) => secret.id),
    [props.existingSecrets, selectedScope],
  );

  useEffect(() => {
    if (props.open) setSelectedScope(props.targetScope);
  }, [props.open, props.targetScope]);

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
          existingSecretIds={selectedExistingSecretIds}
          fallbackId={props.fallbackId}
          onCreated={props.onCreated}
          onCancel={() => props.onOpenChange(false)}
          targetScope={selectedScope}
          secretScopeOptions={allowedScopeOptions}
          onTargetScopeChange={setSelectedScope}
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
  valueKind?: HeaderValueKind;
  literalValue?: string;
  prefix?: string;
  presetKey?: string;
  fromPreset?: boolean;
  /** Scope where this source credential value is used. */
  targetScope?: ScopeId;
  /** Scope that owns the selected reusable secret. */
  secretScope?: ScopeId;
};

export type HeaderValueKind = "secret" | "text";

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
    return {
      name,
      secretId: null,
      literalValue: value,
      valueKind: "text",
      presetKey: matchPresetKey(name, undefined),
    };
  }
  return {
    name,
    secretId: value.secretId,
    valueKind: "secret",
    prefix: value.prefix,
    presetKey: matchPresetKey(name, value.prefix),
  };
}

export function headersFromState(
  entries: readonly HeaderState[],
): Record<string, string | { secretId: string; prefix?: string }> {
  const result: Record<string, string | { secretId: string; prefix?: string }> = {};
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name) continue;
    if (entry.valueKind === "text") {
      if (entry.literalValue?.trim()) {
        result[name] = entry.literalValue.trim();
      }
      continue;
    }
    if (!entry.secretId) continue;
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
  bindingScopeOptions?: readonly CredentialTargetScopeOption[];
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
    bindingScopeOptions,
  } = props;

  const isCustom = presetKey === "custom" || presetKey === undefined;
  const copy = { ...defaultSecretCredentialRowCopy, ...copyOverride };
  const headerLabel = name.trim() || "Custom Header";
  const suggestedName = [sourceName?.trim(), headerLabel].filter(Boolean).join(" ");
  const scopeStack = useScopeStack();
  const scopedSecrets = secretsForCredentialTarget(existingSecrets, targetScope, scopeStack);

  return (
    <div className="space-y-2.5 px-4 py-3">
      <CreateSecretDialog
        open={creating}
        onOpenChange={setCreating}
        suggestedName={suggestedName}
        existingSecrets={existingSecrets}
        onCreated={(id, scopeId) => {
          onSelectSecret(id, scopeId);
          setCreating(false);
        }}
        targetScope={targetScope}
        secretScopeOptions={
          bindingScopeOptions
            ? secretScopeOptionsForCredentialTarget(bindingScopeOptions, targetScope, scopeStack)
            : undefined
        }
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
            secrets={scopedSecrets}
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
    onCreatedScope,
    suggestedId: suggestedIdProp,
    credentialScopeOptions,
  } = props;
  const [creating, setCreating] = useState(false);

  const suggestedName = [sourceName?.trim(), secretLabel].filter(Boolean).join(" ");
  const scopeStack = useScopeStack();
  const scopedSecrets = secretsForCredentialTarget(secrets, targetScope, scopeStack);

  if (creating) {
    return (
      <CreateSecretDialog
        open={creating}
        onOpenChange={setCreating}
        suggestedName={suggestedName}
        existingSecrets={secrets}
        fallbackId={suggestedIdProp?.trim() || "secret"}
        onCreated={(id, scopeId) => {
          onCreatedScope?.(scopeId);
          onSelect(id, scopeId);
          setCreating(false);
        }}
        targetScope={targetScope}
        secretScopeOptions={
          credentialScopeOptions
            ? secretScopeOptionsForCredentialTarget(credentialScopeOptions, targetScope, scopeStack)
            : undefined
        }
      />
    );
  }

  return (
    <SecretPicker
      value={value}
      valueScopeId={String(targetScope)}
      onSelect={(id, scopeId) => onSelect(id, ScopeId.make(scopeId))}
      secrets={scopedSecrets}
      placeholder={placeholder}
      onCreateNew={() => setCreating(true)}
    />
  );
}
