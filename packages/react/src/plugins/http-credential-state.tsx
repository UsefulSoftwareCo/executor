import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ScopeId } from "@executor-js/sdk";

import { Label } from "../components/label";
import { RadioGroup, RadioGroupItem } from "../components/radio-group";
import { cn } from "../lib/utils";
import type { CredentialTargetScopeOption } from "./credential-target-scope";
import {
  configuredCredentialMapFromRows,
  httpCredentialsValid,
  HttpCredentials,
  nonEmptyHttpCredentialFields,
  serializeHttpCredentials,
  serializeScopedHttpCredentials,
  type HttpCredentialRow,
  type HttpCredentialsState,
  type SecretBackedValue,
} from "./http-credentials";
import type { SecretPickerSecret } from "./secret-picker";

type SerializedHttpCredentials = ReturnType<typeof serializeHttpCredentials>;
type SerializedScopedHttpCredentials = ReturnType<typeof serializeScopedHttpCredentials>;
type ConfiguredHttpCredentialMap = ReturnType<typeof configuredCredentialMapFromRows>;

export type HttpCredentialEditorController = {
  readonly state: {
    readonly credentials: HttpCredentialsState;
    readonly targetScope: ScopeId;
    readonly dirty: boolean;
    readonly valid: boolean;
  };
  readonly actions: {
    readonly setCredentials: (credentials: HttpCredentialsState) => void;
    readonly setHeaders: (headers: readonly HttpCredentialRow[]) => void;
    readonly setQueryParams: (queryParams: readonly HttpCredentialRow[]) => void;
    readonly resetDirty: () => void;
  };
  readonly meta: {
    readonly existingSecrets: readonly SecretPickerSecret[];
    readonly sourceName?: string;
    readonly credentialScopeOptions?: readonly CredentialTargetScopeOption[];
    readonly bindingScopeOptions?: readonly CredentialTargetScopeOption[];
    readonly restrictSecretsToTargetScope?: boolean;
  };
  readonly serialized: {
    readonly request: SerializedHttpCredentials;
    readonly requestFields: {
      readonly headers?: Record<string, SecretBackedValue>;
      readonly queryParams?: Record<string, SecretBackedValue>;
    };
    readonly scoped: SerializedScopedHttpCredentials;
    readonly scopedFields: <HeaderValue, QueryParamValue = HeaderValue>() => {
      readonly headers?: Record<string, HeaderValue>;
      readonly queryParams?: Record<string, QueryParamValue>;
    };
    readonly configuredHeaders: (
      slotForName: (name: string) => string,
    ) => ConfiguredHttpCredentialMap;
    readonly configuredQueryParams: (
      slotForName: (name: string) => string,
    ) => ConfiguredHttpCredentialMap;
  };
};

export function useHttpCredentialEditorController(props: {
  readonly initialCredentials: HttpCredentialsState;
  readonly targetScope: ScopeId;
  readonly existingSecrets: readonly SecretPickerSecret[];
  readonly sourceName?: string;
  readonly credentialScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly bindingScopeOptions?: readonly CredentialTargetScopeOption[];
  readonly restrictSecretsToTargetScope?: boolean;
  readonly onCredentialsChange?: (credentials: HttpCredentialsState) => void;
}): HttpCredentialEditorController {
  const {
    initialCredentials,
    targetScope,
    existingSecrets,
    sourceName,
    credentialScopeOptions,
    bindingScopeOptions,
    restrictSecretsToTargetScope,
    onCredentialsChange,
  } = props;
  const [credentials, setCredentialsState] = useState(initialCredentials);
  const [dirty, setDirty] = useState(false);

  const setCredentials = useCallback(
    (next: HttpCredentialsState) => {
      setCredentialsState(next);
      onCredentialsChange?.(next);
      setDirty(true);
    },
    [onCredentialsChange],
  );
  const setHeaders = useCallback(
    (headers: readonly HttpCredentialRow[]) => {
      const next = { ...credentials, headers: [...headers] };
      setCredentialsState(next);
      onCredentialsChange?.(next);
      setDirty(true);
    },
    [credentials, onCredentialsChange],
  );
  const setQueryParams = useCallback(
    (queryParams: readonly HttpCredentialRow[]) => {
      const next = { ...credentials, queryParams: [...queryParams] };
      setCredentialsState(next);
      onCredentialsChange?.(next);
      setDirty(true);
    },
    [credentials, onCredentialsChange],
  );
  const resetDirty = useCallback(() => setDirty(false), []);

  const request = useMemo(() => serializeHttpCredentials(credentials), [credentials]);
  const scoped = useMemo(
    () => serializeScopedHttpCredentials(credentials, targetScope),
    [credentials, targetScope],
  );

  const scopedFields = useCallback(
    <HeaderValue, QueryParamValue = HeaderValue>() =>
      nonEmptyHttpCredentialFields({
        headers: scoped.headers as Record<string, HeaderValue>,
        queryParams: scoped.queryParams as Record<string, QueryParamValue>,
      }),
    [scoped],
  );
  const configuredHeaders = useCallback(
    (slotForName: (name: string) => string) =>
      configuredCredentialMapFromRows(credentials.headers, targetScope, slotForName),
    [credentials.headers, targetScope],
  );
  const configuredQueryParams = useCallback(
    (slotForName: (name: string) => string) =>
      configuredCredentialMapFromRows(credentials.queryParams, targetScope, slotForName),
    [credentials.queryParams, targetScope],
  );

  return {
    state: {
      credentials,
      targetScope,
      dirty,
      valid: httpCredentialsValid(credentials),
    },
    actions: {
      setCredentials,
      setHeaders,
      setQueryParams,
      resetDirty,
    },
    meta: {
      existingSecrets,
      sourceName,
      credentialScopeOptions,
      bindingScopeOptions,
      restrictSecretsToTargetScope,
    },
    serialized: {
      request,
      requestFields: nonEmptyHttpCredentialFields(request),
      scoped,
      scopedFields,
      configuredHeaders,
      configuredQueryParams,
    },
  };
}

function HttpCredentialEditorProvider(props: {
  readonly controller: HttpCredentialEditorController;
  readonly children: ReactNode;
}) {
  const { controller } = props;
  return (
    <HttpCredentials.Root
      credentials={controller.state.credentials}
      onChange={controller.actions.setCredentials}
      existingSecrets={controller.meta.existingSecrets}
      sourceName={controller.meta.sourceName}
      targetScope={controller.state.targetScope}
      credentialScopeOptions={controller.meta.credentialScopeOptions}
      bindingScopeOptions={controller.meta.bindingScopeOptions}
      restrictSecretsToTargetScope={controller.meta.restrictSecretsToTargetScope}
    >
      {props.children}
    </HttpCredentials.Root>
  );
}

const HttpCredentialAuthMethodsContext = createContext<{ readonly value: string } | null>(null);

const useHttpCredentialAuthMethodsContext = () => {
  const context = useContext(HttpCredentialAuthMethodsContext);
  if (context) return context;
  // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React composition invariant
  throw new Error(
    "HttpCredentialEditor auth options must be rendered inside <HttpCredentialEditor.Auth.Root>.",
  );
};

function HttpCredentialAuthRoot(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly label?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <HttpCredentialAuthMethodsContext.Provider value={{ value: props.value }}>
      <div className={cn("space-y-2.5", props.className)}>
        {props.label ? (
          <div className="text-sm font-medium text-foreground">{props.label}</div>
        ) : null}
        <RadioGroup value={props.value} onValueChange={props.onValueChange} className="gap-1.5">
          {props.children}
        </RadioGroup>
      </div>
    </HttpCredentialAuthMethodsContext.Provider>
  );
}

function HttpCredentialAuthOption(props: {
  readonly value: string;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly className?: string;
}) {
  const context = useHttpCredentialAuthMethodsContext();
  const selected = context.value === props.value;
  return (
    <Label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors",
        selected ? "border-primary/50 bg-primary/[0.03]" : "border-border hover:bg-accent/50",
        props.className,
      )}
    >
      <RadioGroupItem value={props.value} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">{props.label}</div>
        {props.detail ? (
          <div className="mt-0.5 text-[10px] text-muted-foreground">{props.detail}</div>
        ) : null}
      </div>
    </Label>
  );
}

function HttpCredentialHeaderAuthOption(props: {
  readonly value: string;
  readonly label: ReactNode;
  readonly names: readonly string[];
}) {
  return (
    <HttpCredentialAuthOption
      value={props.value}
      label={props.label}
      detail={
        props.names.length > 0 ? (
          <span className="font-mono">{props.names.join(" · ")}</span>
        ) : undefined
      }
    />
  );
}

function HttpCredentialOAuthAuthOption(props: {
  readonly value: string;
  readonly label: ReactNode;
  readonly scopeCount?: number;
}) {
  return (
    <HttpCredentialAuthOption
      value={props.value}
      label={props.label}
      detail={
        props.scopeCount === undefined
          ? undefined
          : `${props.scopeCount} scope${props.scopeCount === 1 ? "" : "s"}`
      }
    />
  );
}

function HttpCredentialCustomAuthOption(props: {
  readonly value?: string;
  readonly label?: ReactNode;
}) {
  return (
    <HttpCredentialAuthOption
      value={props.value ?? "custom"}
      label={props.label ?? "Custom"}
      className="items-center"
    />
  );
}

function HttpCredentialNoAuthOption(props: {
  readonly value?: string;
  readonly label?: ReactNode;
}) {
  return (
    <HttpCredentialAuthOption
      value={props.value ?? "none"}
      label={props.label ?? "None"}
      className="items-center"
    />
  );
}

export const HttpCredentialEditor = {
  Provider: HttpCredentialEditorProvider,
  Headers: HttpCredentials.Headers,
  QueryParams: HttpCredentials.QueryParams,
  Auth: {
    Root: HttpCredentialAuthRoot,
    Option: HttpCredentialAuthOption,
    Header: HttpCredentialHeaderAuthOption,
    OAuth: HttpCredentialOAuthAuthOption,
    Custom: HttpCredentialCustomAuthOption,
    None: HttpCredentialNoAuthOption,
  },
} as const;
