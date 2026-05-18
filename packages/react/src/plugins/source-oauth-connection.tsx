import type { ConnectionId, ScopeId, SecretBackedValue } from "@executor-js/sdk/shared";

import {
  CredentialControlField,
  CredentialUsageRow,
  type CredentialTargetScopeOption,
} from "./credential-target-scope";
import {
  effectiveCredentialBindingForScope,
  exactCredentialBindingForScope,
  type CredentialBindingRefLike,
} from "./credential-bindings";
import { SourceOAuthSignInButton } from "./oauth-sign-in";

export const sourceOAuthConnectionUiState = (input: {
  readonly bindings: readonly CredentialBindingRefLike[];
  readonly connectionSlot: string;
  readonly tokenScope: ScopeId;
  readonly scopeRanks: ReadonlyMap<string, number>;
  readonly credentialScopeOptions: readonly CredentialTargetScopeOption[];
  readonly connections: readonly { readonly id: ConnectionId }[];
}): {
  readonly connectionId: ConnectionId | null;
  readonly isConnected: boolean;
  readonly buttonIsConnected: boolean;
  readonly statusLabel: string;
  readonly signInLabel: string;
} => {
  const effectiveBinding = effectiveCredentialBindingForScope(
    input.bindings,
    input.connectionSlot,
    input.tokenScope,
    input.scopeRanks,
  );
  const exactBinding = exactCredentialBindingForScope(
    input.bindings,
    input.connectionSlot,
    input.tokenScope,
  );
  const effectiveConnectionId =
    effectiveBinding?.value.kind === "connection" ? effectiveBinding.value.connectionId : null;
  const exactConnectionId =
    exactBinding?.value.kind === "connection" ? exactBinding.value.connectionId : null;
  const isConnected =
    effectiveConnectionId !== null &&
    input.connections.some((connection) => connection.id === effectiveConnectionId);
  const buttonIsConnected =
    exactConnectionId !== null &&
    input.connections.some((connection) => connection.id === exactConnectionId);
  const selectedScopeLabel =
    input.credentialScopeOptions.find((option) => option.scopeId === input.tokenScope)?.label ??
    "selected scope";
  const inheritedScopeLabel =
    effectiveBinding && effectiveBinding.scopeId !== input.tokenScope
      ? (input.credentialScopeOptions.find((option) => option.scopeId === effectiveBinding.scopeId)
          ?.label ?? "Organization")
      : null;

  return {
    connectionId: exactConnectionId,
    isConnected,
    buttonIsConnected,
    statusLabel: buttonIsConnected
      ? `Connected in ${selectedScopeLabel}`
      : isConnected && inheritedScopeLabel
        ? `Using ${inheritedScopeLabel} connection`
        : `No ${selectedScopeLabel} connection`,
    signInLabel: inheritedScopeLabel ? "Sign in personally" : "Sign in",
  };
};

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
  readonly buttonIsConnected?: boolean;
  readonly statusLabel?: string;
  readonly onConnected: (connectionId: ConnectionId) => void | Promise<void>;
  readonly disabled?: boolean;
  readonly reconnectingLabel?: string;
  readonly signingInLabel?: string;
  readonly reconnectLabel?: string;
  readonly signInLabel?: string;
}) {
  const buttonIsConnected = props.buttonIsConnected ?? props.isConnected;

  return (
    <CredentialUsageRow
      value={props.tokenScope}
      options={props.credentialScopeOptions}
      onChange={props.onTokenScopeChange}
      label="Connection saved to"
      help="Choose who can use the OAuth connection."
    >
      <CredentialControlField label="OAuth connection" help="Start the provider OAuth flow.">
        <div className="flex min-h-9 items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          {props.isConnected ? (
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {props.statusLabel ?? "Connected"}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {props.statusLabel ?? "Not connected"}
            </span>
          )}
          <div className="ml-auto">
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
              isConnected={buttonIsConnected}
              onConnected={props.onConnected}
              reconnectLabel={props.reconnectLabel}
              reconnectingLabel={props.reconnectingLabel}
              signInLabel={props.signInLabel}
              signingInLabel={props.signingInLabel}
            />
          </div>
        </div>
      </CredentialControlField>
    </CredentialUsageRow>
  );
}
