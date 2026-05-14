import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { PlusIcon } from "lucide-react";
import {
  ScopeId,
  type ScopedSecretCredentialInput,
  type SecretBackedValue,
} from "@executor-js/sdk";

import { Button } from "../components/button";
import { CardStack, CardStackContent, CardStackEntry } from "../components/card-stack";
import { Field, FieldGroup, FieldLabel } from "../components/field";
import { HelpTooltip } from "../components/help-tooltip";
import { Input } from "../components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import type { CredentialTargetScopeOption } from "./credential-target-scope";
import { secretsForCredentialTarget } from "./secret-credential-scope";
import { CreatableSecretPicker } from "./creatable-secret-picker";
import type { SecretPickerSecret } from "./secret-picker";

export type { SecretBackedValue };

export type HttpCredentialValueKind = "secret" | "text";

export interface HttpCredentialPreset {
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly prefix?: string;
  readonly valueKind?: HttpCredentialValueKind;
}

export const defaultHeaderCredentialPresets: readonly HttpCredentialPreset[] = [
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

const queryParamCredentialPresets: readonly HttpCredentialPreset[] = [
  { key: "custom", label: "Query parameter", name: "", valueKind: "text" },
];

export type HttpCredentialRow = {
  name: string;
  secretId: string | null;
  prefix?: string;
  literalValue?: string;
  presetKey?: string;
  fromPreset?: boolean;
  /** Scope where this source credential value is used. */
  targetScope?: ScopeId;
  /** Scope that owns the selected reusable secret. */
  secretScope?: ScopeId;
};

export type QueryParamState = HttpCredentialRow;

export type HttpCredentialsState = {
  headers: HttpCredentialRow[];
  queryParams: HttpCredentialRow[];
};

export type ConfiguredHttpCredentialBinding = {
  readonly kind: "binding";
  readonly slot: string;
  readonly prefix?: string;
};

export type ConfiguredHttpCredentialValue = string | ConfiguredHttpCredentialBinding;

export type HttpCredentialBindingDraft = {
  readonly slot: string;
  readonly secretId: string;
  readonly scope: ScopeId;
  readonly secretScope: ScopeId;
};

type HttpCredentialSectionKind = "headers" | "queryParams";

type HttpCredentialRowCopy = {
  readonly rowLabel: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly prefixLabel: string;
  readonly prefixPlaceholder: string;
  readonly secretLabel: string;
  readonly secretHelp: string;
  readonly textLabel: string;
  readonly textHelp: string;
  readonly textPlaceholder: string;
  readonly valueSourceLabel: string;
  readonly valueSourceHelp: string;
  readonly usedByLabel: string;
  readonly usedByHelp: string;
};

const headerRowCopy: HttpCredentialRowCopy = {
  rowLabel: "Header",
  nameLabel: "Name",
  namePlaceholder: "Authorization",
  prefixLabel: "Prefix",
  prefixPlaceholder: "Bearer ",
  secretLabel: "Secret",
  secretHelp: "Select or create a reusable secret.",
  textLabel: "Value",
  textHelp: "Use a plain text value instead of a reusable secret.",
  textPlaceholder: "value",
  valueSourceLabel: "Value from",
  valueSourceHelp: "Choose whether this value comes from a reusable secret or is saved directly.",
  usedByLabel: "Used by",
  usedByHelp: "Choose who uses this credential value.",
};

const queryParamRowCopy: HttpCredentialRowCopy = {
  ...headerRowCopy,
  rowLabel: "Query parameter",
  namePlaceholder: "api-version",
  prefixPlaceholder: "",
};

export const emptyHttpCredentials = (): HttpCredentialsState => ({
  headers: [],
  queryParams: [],
});

export const matchHttpCredentialPreset = (
  name: string,
  prefix?: string,
  presets: readonly HttpCredentialPreset[] = defaultHeaderCredentialPresets,
): string => {
  const preset =
    presets.find((p) => p.name === name && p.prefix === prefix) ??
    presets.find((p) => p.name === name && p.prefix === undefined);
  return preset?.key ?? "custom";
};

export const httpCredentialRowFromValue = (
  name: string,
  value: SecretBackedValue,
  presets: readonly HttpCredentialPreset[] = defaultHeaderCredentialPresets,
): HttpCredentialRow => {
  if (typeof value === "string") {
    return {
      name,
      secretId: null,
      literalValue: value,
      presetKey: matchHttpCredentialPreset(name, undefined, presets),
    };
  }
  return {
    name,
    secretId: value.secretId,
    prefix: value.prefix,
    presetKey: matchHttpCredentialPreset(name, value.prefix, presets),
  };
};

export const httpCredentialsFromValues = (input: {
  readonly headers?: Record<string, SecretBackedValue> | null;
  readonly queryParams?: Record<string, SecretBackedValue> | null;
}): HttpCredentialsState => ({
  headers: Object.entries(input.headers ?? {}).map(([name, value]) =>
    httpCredentialRowFromValue(name, value),
  ),
  queryParams: Object.entries(input.queryParams ?? {}).map(([name, value]) =>
    httpCredentialRowFromValue(name, value, queryParamCredentialPresets),
  ),
});

const rowValueKind = (row: HttpCredentialRow): HttpCredentialValueKind =>
  row.literalValue === undefined ? "secret" : "text";

const literalValueWithPrefix = (row: HttpCredentialRow): string | null => {
  const value = row.literalValue?.trim();
  if (!value) return null;
  return row.prefix ? `${row.prefix}${value}` : value;
};

export const serializeCredentialRows = (
  rows: readonly HttpCredentialRow[],
): Record<string, SecretBackedValue> => {
  const result: Record<string, SecretBackedValue> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.secretId) {
      result[name] = {
        secretId: row.secretId,
        ...(row.prefix ? { prefix: row.prefix } : {}),
      };
      continue;
    }
    const literalValue = literalValueWithPrefix(row);
    if (literalValue) {
      result[name] = literalValue;
    }
  }
  return result;
};

export const serializeHeaderCredentials = (
  headers: readonly HttpCredentialRow[],
): Record<string, SecretBackedValue> => serializeCredentialRows(headers);

export const serializeQueryCredentials = (
  queryParams: readonly HttpCredentialRow[],
): Record<string, SecretBackedValue> => serializeCredentialRows(queryParams);

export const serializeHttpCredentials = (
  credentials: HttpCredentialsState,
): {
  readonly headers: Record<string, SecretBackedValue>;
  readonly queryParams: Record<string, SecretBackedValue>;
} => ({
  headers: serializeHeaderCredentials(credentials.headers),
  queryParams: serializeQueryCredentials(credentials.queryParams),
});

export const serializeScopedCredentialRows = (
  rows: readonly HttpCredentialRow[],
  fallbackTargetScope: ScopeId,
): Record<string, string | ScopedSecretCredentialInput> => {
  const result: Record<string, string | ScopedSecretCredentialInput> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.secretId) {
      const targetScope = row.targetScope ?? fallbackTargetScope;
      result[name] = {
        secretId: row.secretId,
        targetScope,
        ...(row.secretScope ? { secretScopeId: row.secretScope } : {}),
        ...(row.prefix ? { prefix: row.prefix } : {}),
      };
      continue;
    }
    const literalValue = literalValueWithPrefix(row);
    if (literalValue) {
      result[name] = literalValue;
    }
  }
  return result;
};

export const serializeScopedHeaderCredentials = (
  headers: readonly HttpCredentialRow[],
  fallbackTargetScope: ScopeId,
): Record<string, string | ScopedSecretCredentialInput> =>
  serializeScopedCredentialRows(headers, fallbackTargetScope);

export const serializeScopedQueryCredentials = (
  queryParams: readonly HttpCredentialRow[],
  fallbackTargetScope: ScopeId,
): Record<string, string | ScopedSecretCredentialInput> =>
  serializeScopedCredentialRows(queryParams, fallbackTargetScope);

export const serializeScopedHttpCredentials = (
  credentials: HttpCredentialsState,
  fallbackTargetScope: ScopeId,
) => ({
  headers: serializeScopedHeaderCredentials(credentials.headers, fallbackTargetScope),
  queryParams: serializeScopedQueryCredentials(credentials.queryParams, fallbackTargetScope),
});

const rowValid = (row: HttpCredentialRow): boolean => {
  if (!row.name.trim()) return false;
  return Boolean(row.secretId || row.literalValue?.trim());
};

export const httpCredentialsValid = (credentials: HttpCredentialsState): boolean =>
  credentials.headers.every(rowValid) && credentials.queryParams.every(rowValid);

export const configuredCredentialMapFromRows = (
  rows: readonly HttpCredentialRow[],
  fallbackTargetScope: ScopeId,
  slotForName: (name: string) => string,
): {
  readonly values: Record<string, ConfiguredHttpCredentialValue>;
  readonly bindings: readonly HttpCredentialBindingDraft[];
} => {
  const values: Record<string, ConfiguredHttpCredentialValue> = {};
  const bindings: HttpCredentialBindingDraft[] = [];

  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;

    const literalValue = literalValueWithPrefix(row);
    if (!row.secretId && literalValue) {
      values[name] = literalValue;
      continue;
    }

    const slot = slotForName(name);
    values[name] = {
      kind: "binding",
      slot,
      ...(row.prefix ? { prefix: row.prefix } : {}),
    };

    if (row.secretId) {
      const scope = row.targetScope ?? fallbackTargetScope;
      bindings.push({
        slot,
        secretId: row.secretId,
        scope,
        secretScope: row.secretScope ?? scope,
      });
    }
  }

  return { values, bindings };
};

type HttpCredentialsRootProps = {
  readonly credentials: HttpCredentialsState;
  readonly onChange: (credentials: HttpCredentialsState) => void;
  readonly existingSecrets: readonly SecretPickerSecret[];
  readonly sourceName?: string;
  readonly targetScope: ScopeId;
  readonly credentialScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly bindingScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly restrictSecretsToTargetScope?: boolean;
  readonly children: ReactNode;
};

type HttpCredentialsContextValue = Omit<HttpCredentialsRootProps, "children">;

const HttpCredentialsContext = createContext<HttpCredentialsContextValue | null>(null);

const useHttpCredentialsContext = (): HttpCredentialsContextValue => {
  const context = useContext(HttpCredentialsContext);
  if (context) return context;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React composition invariant
  throw new Error(
    "HttpCredentials compound components must be rendered inside <HttpCredentials.Root>.",
  );
};

export function HttpCredentialsRoot(props: HttpCredentialsRootProps) {
  const { children, ...context } = props;
  return (
    <HttpCredentialsContext.Provider value={context}>
      <div className="space-y-4">{children}</div>
    </HttpCredentialsContext.Provider>
  );
}

export function HttpCredentialsHeaders(props: { readonly label?: string }) {
  const context = useHttpCredentialsContext();
  return (
    <HttpCredentialSection
      kind="headers"
      label={props.label ?? "Headers"}
      rows={context.credentials.headers}
      onRowsChange={(headers) => context.onChange({ ...context.credentials, headers })}
      presets={defaultHeaderCredentialPresets}
      emptyLabel="No headers"
      addLabel="Add header"
      addAriaLabel="Add header"
      rowCopy={headerRowCopy}
      defaultValueKind="secret"
    />
  );
}

export function HttpCredentialsQueryParams(props: { readonly label?: string }) {
  const context = useHttpCredentialsContext();
  return (
    <HttpCredentialSection
      kind="queryParams"
      label={props.label ?? "Query parameters"}
      rows={context.credentials.queryParams}
      onRowsChange={(queryParams) => context.onChange({ ...context.credentials, queryParams })}
      presets={queryParamCredentialPresets}
      emptyLabel="No query parameters"
      addLabel="Add query parameter"
      addAriaLabel="Add query parameter"
      rowCopy={queryParamRowCopy}
      defaultValueKind="text"
    />
  );
}

export const HttpCredentials = {
  Root: HttpCredentialsRoot,
  Headers: HttpCredentialsHeaders,
  QueryParams: HttpCredentialsQueryParams,
} as const;

function HttpCredentialSection(props: {
  readonly kind: HttpCredentialSectionKind;
  readonly label: string;
  readonly rows: readonly HttpCredentialRow[];
  readonly onRowsChange: (rows: HttpCredentialRow[]) => void;
  readonly presets: readonly HttpCredentialPreset[];
  readonly emptyLabel: ReactNode;
  readonly addLabel: ReactNode;
  readonly addAriaLabel: string;
  readonly rowCopy: HttpCredentialRowCopy;
  readonly defaultValueKind: HttpCredentialValueKind;
}) {
  const context = useHttpCredentialsContext();
  const [picking, setPicking] = useState(false);
  const addCredentialFromPreset = (preset: HttpCredentialPreset) => {
    props.onRowsChange([
      ...props.rows,
      {
        name: preset.name,
        prefix: preset.prefix,
        presetKey: preset.key,
        secretId: null,
        literalValue: (preset.valueKind ?? props.defaultValueKind) === "text" ? "" : undefined,
        targetScope: context.targetScope,
      },
    ]);
    setPicking(false);
  };
  const addFirstPreset = () => {
    const preset = props.presets[0];
    if (props.presets.length === 1 && preset) {
      addCredentialFromPreset(preset);
      return;
    }
    setPicking(true);
  };
  const updateRow = (index: number, update: Partial<HttpCredentialRow>) => {
    props.onRowsChange(
      props.rows.map((entry, i) => (i === index ? { ...entry, ...update } : entry)),
    );
  };
  const removeRow = (index: number) => {
    props.onRowsChange(props.rows.filter((_, i) => i !== index));
  };

  return (
    <section className="space-y-2.5">
      <FieldLabel>{props.label}</FieldLabel>
      <CardStack>
        <CardStackContent className="[&>*+*]:before:inset-x-0">
          {picking ? (
            <HttpCredentialPresetPicker
              presets={props.presets}
              onPick={addCredentialFromPreset}
              onCancel={() => setPicking(false)}
            />
          ) : props.rows.length === 0 ? (
            <AddCredentialRow
              leading={<span>{props.emptyLabel}</span>}
              onClick={addFirstPreset}
              ariaLabel={props.addAriaLabel}
            />
          ) : (
            <>
              {props.rows.map((row, index) => (
                <HttpCredentialRowEditor
                  key={index}
                  kind={props.kind}
                  row={row}
                  rowCopy={props.rowCopy}
                  onChange={(update) => updateRow(index, update)}
                  onRemove={() => removeRow(index)}
                />
              ))}
              <AddCredentialRow
                leading={props.addLabel}
                onClick={addFirstPreset}
                ariaLabel={props.addAriaLabel}
              />
            </>
          )}
        </CardStackContent>
      </CardStack>
    </section>
  );
}

function AddCredentialRow(props: {
  readonly onClick: () => void;
  readonly leading?: ReactNode;
  readonly ariaLabel: string;
}) {
  return (
    // oxlint-disable-next-line react/forbid-elements
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      aria-label={props.ariaLabel}
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-sm text-muted-foreground outline-none transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent/40 focus-visible:bg-accent/40"
    >
      <span className="min-w-0 flex-1 text-left">{props.leading}</span>
      <PlusIcon aria-hidden className="size-4 shrink-0" />
    </button>
  );
}

function HttpCredentialPresetPicker(props: {
  readonly presets: readonly HttpCredentialPreset[];
  readonly onPick: (preset: HttpCredentialPreset) => void;
  readonly onCancel: () => void;
}) {
  return (
    <CardStackEntry className="flex-wrap gap-2">
      {props.presets.map((preset) => (
        <Button
          key={preset.key}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.onPick(preset)}
        >
          {preset.label}
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={props.onCancel}
        className="text-muted-foreground"
      >
        Cancel
      </Button>
    </CardStackEntry>
  );
}

function InfoLabel(props: { readonly children: string; readonly tooltip: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <FieldLabel>{props.children}</FieldLabel>
      <HelpTooltip label={props.children}>{props.tooltip}</HelpTooltip>
    </div>
  );
}

function HttpCredentialRowEditor(props: {
  readonly kind: HttpCredentialSectionKind;
  readonly row: HttpCredentialRow;
  readonly rowCopy: HttpCredentialRowCopy;
  readonly onChange: (update: Partial<HttpCredentialRow>) => void;
  readonly onRemove: () => void;
}) {
  const context = useHttpCredentialsContext();
  const nameInputId = useId();
  const prefixInputId = useId();
  const valueKind = rowValueKind(props.row);
  const targetScope = props.row.targetScope ?? context.targetScope;
  const scopedSecrets = secretsForCredentialTarget(context.existingSecrets, targetScope);
  const selectableSecrets = context.restrictSecretsToTargetScope
    ? scopedSecrets
    : context.existingSecrets;
  const isCustom = props.row.presetKey === "custom" || props.row.presetKey === undefined;

  const setValueKind = (kind: HttpCredentialValueKind) => {
    if (kind === valueKind) return;
    props.onChange({
      secretId: null,
      secretScope: undefined,
      literalValue: kind === "text" ? "" : undefined,
    });
  };
  const setValueKindFromSelect = (kind: string) => {
    if (kind === "secret" || kind === "text") {
      setValueKind(kind);
    }
  };

  return (
    <div className="space-y-2.5 px-4 py-3">
      <div className="flex w-full items-center justify-between gap-4">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {props.rowCopy.rowLabel}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-destructive"
          onClick={props.onRemove}
        >
          Remove
        </Button>
      </div>

      <FieldGroup className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_12rem]">
        <Field>
          <FieldLabel htmlFor={nameInputId}>{props.rowCopy.nameLabel}</FieldLabel>
          <Input
            id={nameInputId}
            value={props.row.name}
            onChange={(event) =>
              props.onChange({
                name: (event.target as HTMLInputElement).value,
                presetKey: isCustom ? "custom" : props.row.presetKey,
              })
            }
            placeholder={props.rowCopy.namePlaceholder}
            className="font-mono"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={prefixInputId}>
            {props.rowCopy.prefixLabel}{" "}
            <span className="font-normal text-muted-foreground/60">(optional)</span>
          </FieldLabel>
          <Input
            id={prefixInputId}
            value={props.row.prefix ?? ""}
            onChange={(event) =>
              props.onChange({
                prefix: (event.target as HTMLInputElement).value || undefined,
                presetKey: isCustom ? "custom" : props.row.presetKey,
              })
            }
            placeholder={props.rowCopy.prefixPlaceholder}
            className="font-mono"
          />
        </Field>
        <Field>
          <InfoLabel tooltip={props.rowCopy.valueSourceHelp}>
            {props.rowCopy.valueSourceLabel}
          </InfoLabel>
          <Select value={valueKind} onValueChange={setValueKindFromSelect}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="secret">Saved secret</SelectItem>
              <SelectItem value="text">Plain value</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>

      {valueKind === "secret" ? (
        <div
          className={
            context.bindingScopeOptions && context.bindingScopeOptions.length > 1
              ? "grid gap-2 md:grid-cols-2"
              : undefined
          }
        >
          <div className="space-y-1.5">
            <InfoLabel tooltip={props.rowCopy.secretHelp}>{props.rowCopy.secretLabel}</InfoLabel>
            <CreatableSecretPicker
              value={props.row.secretId}
              valueScope={props.row.secretScope ?? targetScope}
              onSelect={(secretId, scopeId) =>
                props.onChange({
                  secretId,
                  secretScope: scopeId,
                  literalValue: undefined,
                })
              }
              secrets={selectableSecrets}
              sourceName={context.sourceName}
              secretLabel={props.row.name.trim() || props.rowCopy.rowLabel}
              targetScope={targetScope}
              credentialScopeOptions={context.credentialScopeOptions}
              onCreatedScope={(secretScope) => props.onChange({ secretScope })}
            />
          </div>
          {context.bindingScopeOptions && context.bindingScopeOptions.length > 1 && (
            <div className="space-y-1.5">
              <InfoLabel tooltip={props.rowCopy.usedByHelp}>{props.rowCopy.usedByLabel}</InfoLabel>
              <Select
                value={String(targetScope)}
                onValueChange={(nextScope) =>
                  props.onChange({
                    secretId: null,
                    secretScope: undefined,
                    literalValue: undefined,
                    targetScope: ScopeId.make(nextScope),
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Used by" />
                </SelectTrigger>
                <SelectContent>
                  {context.bindingScopeOptions.map((option) => (
                    <SelectItem key={option.scopeId} value={option.scopeId}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      ) : (
        <Field>
          <InfoLabel tooltip={props.rowCopy.textHelp}>{props.rowCopy.textLabel}</InfoLabel>
          <Input
            value={props.row.literalValue ?? ""}
            onChange={(event) =>
              props.onChange({
                secretId: null,
                secretScope: undefined,
                literalValue: (event.target as HTMLInputElement).value,
              })
            }
            placeholder={props.rowCopy.textPlaceholder}
            className="font-mono"
          />
        </Field>
      )}

      <HttpCredentialPreview kind={props.kind} row={props.row} />
    </div>
  );
}

function HttpCredentialPreview(props: {
  readonly kind: HttpCredentialSectionKind;
  readonly row: HttpCredentialRow;
}) {
  const name = props.row.name.trim();
  if (!name) return null;
  const prefix = props.row.prefix;
  const value =
    rowValueKind(props.row) === "secret"
      ? props.row.secretId
        ? "•".repeat(12)
        : null
      : props.row.literalValue?.trim();
  if (!value) return null;

  if (props.kind === "queryParams") {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs">
        <span className="text-muted-foreground">?{name}=</span>
        <span className="text-foreground">
          {prefix && <span className="text-muted-foreground">{prefix}</span>}
          {value}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs">
      <span className="text-muted-foreground shrink-0">{name}:</span>
      <span className="text-foreground truncate">
        {prefix && <span className="text-muted-foreground">{prefix}</span>}
        {value}
      </span>
    </div>
  );
}
