import type {
  ScopeId,
  ScopedSecretCredentialInput,
  SecretBackedValue,
} from "@executor-js/sdk/shared";

import { FieldLabel } from "../components/field";
import { HeadersList } from "./headers-list";
import {
  headerValueToState,
  headersFromState,
  QueryParamCredentialValuePreview,
  type HeaderAuthPreset,
  type HeaderState,
} from "./secret-header-auth";
import type { CredentialTargetScopeOption } from "./credential-target-scope";
import {
  type ConfiguredCredentialValueLike,
  type CredentialBindingRefLike,
} from "./credential-bindings";
import type { SecretPickerSecret } from "./secret-picker";

export type { SecretBackedValue };

export type QueryParamState = {
  name: string;
  secretId: string | null;
  valueKind?: "secret" | "text";
  prefix?: string;
  literalValue?: string;
  targetScope?: ScopeId;
  secretScope?: ScopeId;
};

const queryParamPresets: readonly HeaderAuthPreset[] = [
  { key: "custom", label: "Query parameter", name: "" },
];

export type HttpCredentialsState = {
  headers: HeaderState[];
  queryParams: QueryParamState[];
};

export const emptyHttpCredentials = (): HttpCredentialsState => ({
  headers: [],
  queryParams: [],
});

export const httpCredentialsFromValues = (input: {
  readonly headers?: Record<string, SecretBackedValue> | null;
  readonly queryParams?: Record<string, SecretBackedValue> | null;
}): HttpCredentialsState => ({
  headers: Object.entries(input.headers ?? {}).map(([name, value]) =>
    headerValueToState(name, value),
  ),
  queryParams: Object.entries(input.queryParams ?? {}).map(([name, value]) => {
    if (typeof value === "string") {
      return { name, secretId: null, literalValue: value, valueKind: "text" as const };
    }
    return { name, secretId: value.secretId, prefix: value.prefix, valueKind: "secret" as const };
  }),
});

export const serializeHeaderCredentials = (
  headers: readonly HeaderState[],
): Record<string, SecretBackedValue> => headersFromState(headers);

export const serializeQueryCredentials = (
  queryParams: readonly QueryParamState[],
): Record<string, SecretBackedValue> => {
  const result: Record<string, SecretBackedValue> = {};
  for (const param of queryParams) {
    const name = param.name.trim();
    if (!name) continue;
    if (param.secretId) {
      result[name] = {
        secretId: param.secretId,
        ...(param.prefix ? { prefix: param.prefix } : {}),
      };
      continue;
    }
    if (param.literalValue?.trim()) {
      result[name] = param.literalValue.trim();
    }
  }
  return result;
};

export const serializeHttpCredentials = (
  credentials: HttpCredentialsState,
): {
  readonly headers: Record<string, SecretBackedValue>;
  readonly queryParams: Record<string, SecretBackedValue>;
} => ({
  headers: serializeHeaderCredentials(credentials.headers),
  queryParams: serializeQueryCredentials(credentials.queryParams),
});

export const serializeScopedHeaderCredentials = (
  headers: readonly HeaderState[],
  fallbackTargetScope: ScopeId,
): Record<string, ScopedSecretCredentialInput> => {
  const result: Record<string, ScopedSecretCredentialInput> = {};
  for (const header of headers) {
    const name = header.name.trim();
    if (!name || !header.secretId) continue;
    const targetScope = header.targetScope ?? fallbackTargetScope;
    result[name] = {
      secretId: header.secretId,
      targetScope,
      ...(header.secretScope ? { secretScopeId: header.secretScope } : {}),
      ...(header.prefix ? { prefix: header.prefix } : {}),
    };
  }
  return result;
};

export const serializeScopedQueryCredentials = (
  queryParams: readonly QueryParamState[],
  fallbackTargetScope: ScopeId,
): Record<string, string | ScopedSecretCredentialInput> => {
  const result: Record<string, string | ScopedSecretCredentialInput> = {};
  for (const param of queryParams) {
    const name = param.name.trim();
    if (!name) continue;
    if (param.secretId) {
      const targetScope = param.targetScope ?? fallbackTargetScope;
      result[name] = {
        secretId: param.secretId,
        targetScope,
        ...(param.secretScope ? { secretScopeId: param.secretScope } : {}),
        ...(param.prefix ? { prefix: param.prefix } : {}),
      };
      continue;
    }
    if (param.literalValue?.trim()) {
      result[name] = param.literalValue.trim();
    }
  }
  return result;
};

export const serializeScopedHttpCredentials = (
  credentials: HttpCredentialsState,
  fallbackTargetScope: ScopeId,
) => ({
  headers: serializeScopedHeaderCredentials(credentials.headers, fallbackTargetScope),
  queryParams: serializeScopedQueryCredentials(credentials.queryParams, fallbackTargetScope),
});

export type HttpConfigureCredentialInput =
  | string
  | {
      readonly kind: "text";
      readonly text: string;
      readonly prefix?: string;
    }
  | {
      readonly kind: "secret";
      readonly secretId: string;
      readonly secretScope?: ScopeId;
      readonly prefix?: string;
    };

export const serializeConfigureHeaderCredentials = (
  headers: readonly HeaderState[],
  fallbackSecretScope: ScopeId,
): Record<string, HttpConfigureCredentialInput> => {
  const result: Record<string, HttpConfigureCredentialInput> = {};
  for (const header of headers) {
    const name = header.name.trim();
    if (!name) continue;
    if (header.valueKind === "text") {
      if (header.literalValue?.trim()) {
        result[name] = header.literalValue.trim();
      }
      continue;
    }
    if (!header.secretId) continue;
    result[name] = {
      kind: "secret",
      secretId: header.secretId,
      secretScope: header.secretScope ?? fallbackSecretScope,
      ...(header.prefix ? { prefix: header.prefix } : {}),
    };
  }
  return result;
};

export const serializeConfigureQueryCredentials = (
  queryParams: readonly QueryParamState[],
  fallbackSecretScope: ScopeId,
): Record<string, HttpConfigureCredentialInput> => {
  const result: Record<string, HttpConfigureCredentialInput> = {};
  for (const param of queryParams) {
    const name = param.name.trim();
    if (!name) continue;
    if (param.secretId) {
      result[name] = {
        kind: "secret",
        secretId: param.secretId,
        secretScope: param.secretScope ?? fallbackSecretScope,
        ...(param.prefix ? { prefix: param.prefix } : {}),
      };
      continue;
    }
    if (param.literalValue?.trim()) {
      result[name] = param.literalValue.trim();
    }
  }
  return result;
};

export const serializeConfigureHttpCredentials = (
  credentials: HttpCredentialsState,
  fallbackSecretScope: ScopeId,
) => ({
  headers: serializeConfigureHeaderCredentials(credentials.headers, fallbackSecretScope),
  queryParams: serializeConfigureQueryCredentials(credentials.queryParams, fallbackSecretScope),
});

export type HttpTemplateCredentialInput =
  | string
  | { readonly kind: "secret"; readonly prefix?: string };

export const serializeTemplateHeaderCredentials = (
  headers: readonly HeaderState[],
): Record<string, HttpTemplateCredentialInput> => {
  const result: Record<string, HttpTemplateCredentialInput> = {};
  for (const header of headers) {
    const name = header.name.trim();
    if (!name) continue;
    if (header.valueKind === "text") {
      if (header.literalValue?.trim()) {
        result[name] = header.literalValue.trim();
      }
      continue;
    }
    if (!header.secretId) continue;
    result[name] = {
      kind: "secret",
      ...(header.prefix ? { prefix: header.prefix } : {}),
    };
  }
  return result;
};

export const serializeTemplateQueryCredentials = (
  queryParams: readonly QueryParamState[],
): Record<string, HttpTemplateCredentialInput> => {
  const result: Record<string, HttpTemplateCredentialInput> = {};
  for (const param of queryParams) {
    const name = param.name.trim();
    if (!name) continue;
    if (param.secretId) {
      result[name] = {
        kind: "secret",
        ...(param.prefix ? { prefix: param.prefix } : {}),
      };
      continue;
    }
    if (param.literalValue?.trim()) {
      result[name] = param.literalValue.trim();
    }
  }
  return result;
};

const bindingBySlot = (
  bindings: readonly CredentialBindingRefLike[],
): ReadonlyMap<string, CredentialBindingRefLike> =>
  new Map(bindings.map((binding) => [binding.slotKey, binding]));

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
    return { name, secretId: null, literalValue: value, valueKind: "text" };
  }

  const binding = bindings.get(value.slot);
  if (binding?.value.kind === "secret") {
    return {
      name,
      secretId: binding.value.secretId,
      valueKind: "secret",
      prefix: value.prefix,
      targetScope: binding.scopeId,
      secretScope: binding.value.secretScopeId,
    };
  }

  if (binding?.value.kind === "text") {
    return { name, secretId: null, literalValue: binding.value.text, valueKind: "text" };
  }

  return null;
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

export const serializeTemplateHttpCredentials = (credentials: HttpCredentialsState) => ({
  headers: serializeTemplateHeaderCredentials(credentials.headers),
  queryParams: serializeTemplateQueryCredentials(credentials.queryParams),
});

export const httpCredentialsValid = (credentials: HttpCredentialsState): boolean =>
  credentials.headers.every((header) => {
    if (!header.name.trim()) return false;
    return header.valueKind === "text"
      ? Boolean(header.literalValue?.trim())
      : Boolean(header.secretId);
  }) &&
  credentials.queryParams.every((param) => {
    if (!param.name.trim()) return false;
    return Boolean(param.secretId || param.literalValue?.trim());
  });

export function HttpCredentialsEditor(props: {
  readonly credentials: HttpCredentialsState;
  readonly onChange: (credentials: HttpCredentialsState) => void;
  readonly existingSecrets: readonly SecretPickerSecret[];
  readonly sourceName?: string;
  readonly targetScope: ScopeId;
  readonly credentialScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly bindingScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly sections?: {
    readonly headers?: boolean;
    readonly queryParams?: boolean;
  };
  readonly labels?: {
    readonly headers?: string;
    readonly queryParams?: string;
  };
  readonly headerPresets?: readonly HeaderAuthPreset[];
}) {
  const showHeaders = props.sections?.headers ?? true;
  const showQueryParams = props.sections?.queryParams ?? true;

  return (
    <div className="space-y-4">
      {showHeaders && (
        <section className="space-y-2.5">
          <FieldLabel>{props.labels?.headers ?? "Headers"}</FieldLabel>
          <HeadersList
            headers={props.credentials.headers}
            onHeadersChange={(headers) => props.onChange({ ...props.credentials, headers })}
            existingSecrets={props.existingSecrets}
            sourceName={props.sourceName}
            targetScope={props.targetScope}
            credentialScopeOptions={props.credentialScopeOptions}
            bindingScopeOptions={props.bindingScopeOptions}
            presets={props.headerPresets}
          />
        </section>
      )}

      {showQueryParams && (
        <section className="space-y-2.5">
          <FieldLabel>{props.labels?.queryParams ?? "Query parameters"}</FieldLabel>
          <HeadersList
            headers={props.credentials.queryParams}
            onHeadersChange={(queryParams) => props.onChange({ ...props.credentials, queryParams })}
            existingSecrets={props.existingSecrets}
            sourceName={props.sourceName}
            targetScope={props.targetScope}
            credentialScopeOptions={props.credentialScopeOptions}
            bindingScopeOptions={props.bindingScopeOptions}
            presets={queryParamPresets}
            emptyLabel="No query parameters"
            addLabel="Add query parameter"
            addAriaLabel="Add query parameter"
            rowCopy={{
              rowLabel: "Query parameter",
              namePlaceholder: "token",
            }}
            rowPreviewComponent={QueryParamCredentialValuePreview}
          />
        </section>
      )}
    </div>
  );
}
