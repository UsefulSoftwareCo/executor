import { useState, type ReactNode } from "react";
import { PlusIcon } from "lucide-react";
import type { ScopeId } from "@executor-js/sdk/shared";

import { Button } from "../components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEmpty,
  CardStackEntry,
} from "../components/card-stack";
import { Field, FieldGroup, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import {
  defaultHeaderAuthPresets,
  type HeaderAuthPreset,
  type HeaderState,
  SecretHeaderAuthRow,
  type SecretCredentialPreviewComponent,
  type SecretCredentialRowCopy,
} from "./secret-header-auth";
import type { CredentialTargetScopeOption } from "./credential-target-scope";
import type { SecretPickerSecret } from "./secret-picker";

export interface HeadersListProps {
  readonly headers: readonly HeaderState[];
  readonly onHeadersChange: (headers: HeaderState[]) => void;
  readonly existingSecrets?: readonly SecretPickerSecret[];
  /** Presets offered in the quick-add picker. Defaults to `defaultHeaderAuthPresets`. */
  readonly presets?: readonly HeaderAuthPreset[];
  /** When true, only allow a single header (hide add button, disable remove). */
  readonly singleHeader?: boolean;
  /** Text shown in the empty state. */
  readonly emptyLabel?: ReactNode;
  readonly addLabel?: ReactNode;
  readonly addAriaLabel?: string;
  readonly rowCopy?: Partial<SecretCredentialRowCopy>;
  readonly rowPreviewComponent?: SecretCredentialPreviewComponent;
  /**
   * Display name of the source that owns these headers (e.g. "Axiom"). Used
   * to derive unique default secret labels/IDs like `axiom-authorization`.
   */
  readonly sourceName?: string;
  /** Inline-created secrets are written to this explicit scope. */
  readonly targetScope: ScopeId;
  /** Scope choices available for where this source credential is used. */
  readonly credentialScopeOptions?: readonly CredentialTargetScopeOption[];
  /** Scope choices for where this source credential is used. */
  readonly bindingScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly defaultValueKind?: HeaderState["valueKind"];
}

export function HeadersList({
  headers,
  onHeadersChange,
  existingSecrets = [],
  presets = defaultHeaderAuthPresets,
  singleHeader = false,
  emptyLabel = "No headers",
  addLabel,
  addAriaLabel = "Add header",
  rowCopy,
  rowPreviewComponent,
  sourceName,
  targetScope,
  bindingScopeOptions,
  defaultValueKind = "secret",
}: HeadersListProps) {
  const [picking, setPicking] = useState(false);
  const canAddMore = !singleHeader || headers.length === 0;
  const addFirstPreset = () => {
    const preset = presets[0];
    if (presets.length === 1 && preset) {
      addHeaderFromPreset(preset);
      return;
    }
    setPicking(true);
  };

  const addHeaderFromPreset = (preset: HeaderAuthPreset) => {
    onHeadersChange([
      ...headers,
      {
        name: preset.name,
        prefix: preset.prefix,
        presetKey: preset.key,
        secretId: null,
        valueKind: preset.valueKind ?? defaultValueKind,
        targetScope,
      },
    ]);
    setPicking(false);
  };

  const updateHeader = (
    index: number,
    update: Partial<{
      name: string;
      secretId: string | null;
      prefix?: string;
      presetKey?: string;
      valueKind?: HeaderState["valueKind"];
      literalValue?: string;
      targetScope?: ScopeId;
      secretScope?: ScopeId;
    }>,
  ) => {
    onHeadersChange(headers.map((entry, i) => (i === index ? { ...entry, ...update } : entry)));
  };

  const removeHeader = (index: number) => {
    onHeadersChange(headers.filter((_, i) => i !== index));
  };

  return (
    <CardStack>
      <CardStackContent className="[&>*+*]:before:inset-x-0">
        {picking ? (
          <HeaderPresetPicker
            presets={presets}
            onPick={addHeaderFromPreset}
            onCancel={() => setPicking(false)}
          />
        ) : headers.length === 0 ? (
          canAddMore ? (
            <AddHeaderRow
              leading={<span>{emptyLabel}</span>}
              onClick={addFirstPreset}
              ariaLabel={addAriaLabel}
            />
          ) : (
            <CardStackEmpty>
              <span>{emptyLabel}</span>
            </CardStackEmpty>
          )
        ) : (
          <>
            {headers.map((header, index) => (
              <HeaderRow
                key={index}
                header={header}
                targetScope={targetScope}
                onChange={(update) => updateHeader(index, update)}
                onSelectSecret={(secretId, scopeId) =>
                  updateHeader(index, {
                    secretId,
                    ...(scopeId ? { secretScope: scopeId } : {}),
                  })
                }
                onRemove={singleHeader ? undefined : () => removeHeader(index)}
                existingSecrets={existingSecrets}
                sourceName={sourceName}
                bindingScopeOptions={bindingScopeOptions}
                copy={rowCopy}
                previewComponent={rowPreviewComponent}
              />
            ))}
            {canAddMore && (
              <AddHeaderRow leading={addLabel} onClick={addFirstPreset} ariaLabel={addAriaLabel} />
            )}
          </>
        )}
      </CardStackContent>
    </CardStack>
  );
}

function HeaderRow(props: {
  readonly header: HeaderState;
  readonly targetScope: ScopeId;
  readonly onChange: (
    update: Partial<{
      name: string;
      secretId: string | null;
      prefix?: string;
      presetKey?: string;
      valueKind?: HeaderState["valueKind"];
      literalValue?: string;
      targetScope?: ScopeId;
      secretScope?: ScopeId;
    }>,
  ) => void;
  readonly onSelectSecret: (secretId: string, scopeId?: ScopeId) => void;
  readonly onRemove?: () => void;
  readonly existingSecrets: readonly SecretPickerSecret[];
  readonly sourceName?: string;
  readonly bindingScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly copy?: Partial<SecretCredentialRowCopy>;
  readonly previewComponent?: SecretCredentialPreviewComponent;
}) {
  if (props.header.valueKind === "text") {
    return (
      <TextHeaderRow
        name={props.header.name}
        value={props.header.literalValue ?? ""}
        onChange={(update) => props.onChange(update)}
        onRemove={props.onRemove}
        rowLabel={props.copy?.rowLabel}
        nameLabel={props.copy?.nameLabel}
        namePlaceholder={props.copy?.namePlaceholder}
      />
    );
  }

  return (
    <SecretHeaderAuthRow
      name={props.header.name}
      prefix={props.header.prefix}
      presetKey={props.header.presetKey}
      secretId={props.header.secretId}
      secretScope={props.header.secretScope}
      onChange={props.onChange}
      onSelectSecret={props.onSelectSecret}
      onRemove={props.onRemove}
      existingSecrets={props.existingSecrets}
      sourceName={props.sourceName}
      targetScope={props.header.targetScope ?? props.targetScope}
      bindingScopeOptions={props.bindingScopeOptions}
      copy={props.copy}
      previewComponent={props.previewComponent}
    />
  );
}

function TextHeaderRow(props: {
  readonly name: string;
  readonly value: string;
  readonly onChange: (update: { name?: string; literalValue?: string }) => void;
  readonly onRemove?: () => void;
  readonly rowLabel?: string;
  readonly nameLabel?: string;
  readonly namePlaceholder?: string;
}) {
  return (
    <div className="space-y-2.5 px-4 py-3">
      <div className="flex w-full items-center justify-between gap-4">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {props.rowLabel ?? "Header"}
        </span>
        {props.onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-destructive"
            onClick={props.onRemove}
          >
            Remove
          </Button>
        )}
      </div>
      <FieldGroup className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel>{props.nameLabel ?? "Name"}</FieldLabel>
          <Input
            value={props.name}
            onChange={(event) => props.onChange({ name: (event.target as HTMLInputElement).value })}
            placeholder={props.namePlaceholder ?? "X-Organization-Id"}
            className="font-mono"
          />
        </Field>
        <Field>
          <FieldLabel>Value</FieldLabel>
          <Input
            value={props.value}
            onChange={(event) =>
              props.onChange({ literalValue: (event.target as HTMLInputElement).value })
            }
            placeholder="workspace-id"
            className="font-mono"
          />
        </Field>
      </FieldGroup>
    </div>
  );
}

interface AddHeaderRowProps {
  readonly onClick: () => void;
  readonly leading?: ReactNode;
  readonly ariaLabel: string;
}

function AddHeaderRow({ onClick, leading, ariaLabel }: AddHeaderRowProps) {
  return (
    // oxlint-disable-next-line react/forbid-elements
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={ariaLabel}
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-sm text-muted-foreground outline-none transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent/40 focus-visible:bg-accent/40"
    >
      <span className="min-w-0 flex-1 text-left">{leading}</span>
      <PlusIcon aria-hidden className="size-4 shrink-0" />
    </button>
  );
}

interface HeaderPresetPickerProps {
  readonly presets: readonly HeaderAuthPreset[];
  readonly onPick: (preset: HeaderAuthPreset) => void;
  readonly onCancel: () => void;
}

function HeaderPresetPicker({ presets, onPick, onCancel }: HeaderPresetPickerProps) {
  return (
    <CardStackEntry className="flex-wrap gap-2">
      {presets.map((preset) => (
        <Button
          key={preset.key}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPick(preset)}
        >
          {preset.label}
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onCancel}
        className="text-muted-foreground"
      >
        Cancel
      </Button>
    </CardStackEntry>
  );
}
