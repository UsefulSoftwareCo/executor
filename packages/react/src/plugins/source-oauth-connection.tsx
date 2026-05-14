import { useCallback, useMemo, type ReactNode } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { CheckIcon } from "lucide-react";
import type { ConnectionId, ScopeId, SecretBackedValue } from "@executor-js/sdk";

import { connectionsAtom, setSourceCredentialBinding } from "../api/atoms";
import { connectionWriteKeys, sourceWriteKeys } from "../api/reactivity-keys";
import { useScope, useScopeStack } from "../api/scope-context";
import { Spinner } from "../components/spinner";
import {
  effectiveCredentialBindingForScope,
  type SourceCredentialBindingRef,
} from "./credential-bindings";
import {
  CredentialControlField,
  CredentialUsageRow,
  type CredentialTargetScopeOption,
} from "./credential-target-scope";
import { SourceOAuthSignInButton } from "./oauth-sign-in";

export type OAuthConnectionStatus =
  | { readonly kind: "idle"; readonly label?: ReactNode }
  | { readonly kind: "busy"; readonly label?: ReactNode }
  | { readonly kind: "connected"; readonly label?: ReactNode }
  | { readonly kind: "blocked"; readonly label: ReactNode };

const statusClassByKind: Record<OAuthConnectionStatus["kind"], string> = {
  busy: "border-blue-500/30 bg-blue-500/5 text-blue-600 dark:text-blue-400",
  connected: "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
  blocked: "border-border bg-muted/30 text-muted-foreground",
  idle: "border-border bg-muted/30 text-muted-foreground",
};

const defaultStatusLabelByKind: Record<OAuthConnectionStatus["kind"], ReactNode> = {
  busy: "Connecting...",
  connected: "Connected",
  blocked: null,
  idle: "Not connected",
};

const statusClasses = (status: OAuthConnectionStatus): string => statusClassByKind[status.kind];

const statusLabel = (status: OAuthConnectionStatus): ReactNode => {
  if (status.label !== undefined) return status.label;
  return defaultStatusLabelByKind[status.kind];
};

export function useSourceOAuthConnectionBinding(props: {
  readonly pluginId: string;
  readonly sourceId: string;
  readonly sourceScope: ScopeId;
  readonly slotKey: string;
  readonly targetScope: ScopeId;
  readonly bindings: readonly SourceCredentialBindingRef[];
}) {
  const displayScope = useScope();
  const scopeStack = useScopeStack();
  const connectionsResult = useAtomValue(connectionsAtom(displayScope));
  const setBinding = useAtomSet(setSourceCredentialBinding, { mode: "promise" });
  const scopeRanks = useMemo(
    () => new Map(scopeStack.map((scope, index) => [scope.id, index] as const)),
    [scopeStack],
  );
  const connectionBinding = effectiveCredentialBindingForScope(
    props.bindings,
    props.slotKey,
    props.targetScope,
    scopeRanks,
  );
  const connectionId =
    connectionBinding?.value.kind === "connection" ? connectionBinding.value.connectionId : null;
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
  const isConnected =
    connectionId !== null && connections.some((connection) => connection.id === connectionId);
  const onConnected = useCallback(
    async (nextConnectionId: ConnectionId) => {
      await setBinding({
        params: { scopeId: props.targetScope },
        payload: {
          targetScope: props.targetScope,
          pluginId: props.pluginId,
          sourceId: props.sourceId,
          sourceScope: props.sourceScope,
          slotKey: props.slotKey,
          value: { kind: "connection", connectionId: nextConnectionId },
        },
        reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
      });
    },
    [
      props.pluginId,
      props.sourceId,
      props.sourceScope,
      props.slotKey,
      props.targetScope,
      setBinding,
    ],
  );

  return { connectionId, isConnected, onConnected };
}

export function OAuthConnectionControl(props: {
  readonly tokenScope: ScopeId;
  readonly onTokenScopeChange: (scope: ScopeId) => void;
  readonly credentialScopeOptions: readonly CredentialTargetScopeOption[];
  readonly status: OAuthConnectionStatus;
  readonly children?: ReactNode;
  readonly label?: string;
  readonly help?: ReactNode;
  readonly scopeLabel?: string;
  readonly scopeHelp?: ReactNode;
}) {
  return (
    <CredentialUsageRow
      value={props.tokenScope}
      options={props.credentialScopeOptions}
      onChange={props.onTokenScopeChange}
      label={props.scopeLabel ?? "Connection saved to"}
      help={props.scopeHelp ?? "Choose who can use the OAuth connection."}
    >
      <CredentialControlField
        label={props.label ?? "OAuth connection"}
        help={props.help ?? "Start the provider OAuth flow."}
      >
        <div
          className={`flex min-h-9 items-center gap-2 rounded-md border px-3 py-2 text-xs ${statusClasses(
            props.status,
          )}`}
        >
          {props.status.kind === "busy" && <Spinner className="size-3.5 shrink-0" />}
          {props.status.kind === "connected" && <CheckIcon className="size-3.5 shrink-0" />}
          <span className="min-w-0 flex-1">{statusLabel(props.status)}</span>
          {props.children ? (
            <div className="ml-auto flex shrink-0 gap-1.5">{props.children}</div>
          ) : null}
        </div>
      </CredentialControlField>
    </CredentialUsageRow>
  );
}

export function SourceOAuthConnectionControl(props: {
  readonly popupName: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly fallbackNamespace: string;
  readonly endpoint: string;
  readonly tokenScope: ScopeId;
  readonly onTokenScopeChange: (scope: ScopeId) => void;
  readonly credentialScopeOptions: readonly CredentialTargetScopeOption[];
  readonly connectionId: string | null;
  readonly sourceLabel: string;
  readonly headers?: Record<string, SecretBackedValue>;
  readonly queryParams?: Record<string, SecretBackedValue>;
  readonly isConnected: boolean;
  readonly onConnected: (connectionId: ConnectionId) => void | Promise<void>;
  readonly reconnectingLabel?: string;
  readonly signingInLabel?: string;
}) {
  return (
    <OAuthConnectionControl
      tokenScope={props.tokenScope}
      credentialScopeOptions={props.credentialScopeOptions}
      onTokenScopeChange={props.onTokenScopeChange}
      status={props.isConnected ? { kind: "connected" } : { kind: "idle" }}
    >
      <SourceOAuthSignInButton
        popupName={props.popupName}
        pluginId={props.pluginId}
        namespace={props.namespace}
        fallbackNamespace={props.fallbackNamespace}
        endpoint={props.endpoint}
        tokenScope={props.tokenScope}
        connectionId={props.connectionId}
        sourceLabel={props.sourceLabel}
        headers={props.headers}
        queryParams={props.queryParams}
        isConnected={props.isConnected}
        onConnected={props.onConnected}
        reconnectingLabel={props.reconnectingLabel}
        signingInLabel={props.signingInLabel}
      />
    </OAuthConnectionControl>
  );
}
