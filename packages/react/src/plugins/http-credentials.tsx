import type { ScopeId, ScopedSecretCredentialInput, SecretBackedValue } from "@executor-js/sdk";

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
import type { SecretPickerSecret } from "./secret-picker";

export type { SecretBackedValue };

export type QueryParamState = {
  name: string;
  secretId: string | null;
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
      return { name, secretId: null, literalValue: value };
    }
    return { name, secretId: value.secretId, prefix: value.prefix };
  }),
});

export const serializeHeaderCredentials = (
  headers: readonly HeaderState[],
): Record<string, { secretId: string; prefix?: string }> => headersFromState(headers);

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
  readonly headers: Record<string, { secretId: string; prefix?: string }>;
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

export const httpCredentialsValid = (credentials: HttpCredentialsState): boolean =>
  credentials.headers.every((header) => header.name.trim() && header.secretId) &&
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
  readonly restrictSecretsToTargetScope?: boolean;
  readonly sections?: {
    readonly headers?: boolean;
    readonly queryParams?: boolean;
  };
  readonly labels?: {
    readonly headers?: string;
    readonly queryParams?: string;
  };
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
            restrictSecretsToTargetScope={props.restrictSecretsToTargetScope}
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
            restrictSecretsToTargetScope={props.restrictSecretsToTargetScope}
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
