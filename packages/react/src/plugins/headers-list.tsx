import { useState, type ReactNode } from "react";
import { PlusIcon } from "lucide-react";
import type { ScopeId } from "@executor-js/sdk";

import { Button } from "../components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEmpty,
  CardStackEntry,
} from "../components/card-stack";
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
  /** Scope choices shown only inside the inline "+ New secret" form. */
  readonly credentialScopeOptions?: readonly CredentialTargetScopeOption[];
  /** Scope choices for where this source credential is used. */
  readonly bindingScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly restrictSecretsToTargetScope?: boolean;
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
  credentialScopeOptions,
  bindingScopeOptions,
  restrictSecretsToTargetScope,
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
              <SecretHeaderAuthRow
                key={index}
                name={header.name}
                prefix={header.prefix}
                presetKey={header.presetKey}
                secretId={header.secretId}
                secretScope={header.secretScope}
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
                targetScope={header.targetScope ?? targetScope}
                credentialScopeOptions={credentialScopeOptions}
                bindingScopeOptions={bindingScopeOptions}
                restrictSecretsToTargetScope={restrictSecretsToTargetScope}
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
