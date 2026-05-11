import type { ConnectionId, ScopeId, SecretBackedValue } from "@executor-js/sdk";

import {
  CredentialControlField,
  CredentialUsageRow,
  type CredentialTargetScopeOption,
} from "./credential-target-scope";
import { SourceOAuthSignInButton } from "./oauth-sign-in";

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
  readonly disabled?: boolean;
  readonly reconnectingLabel?: string;
  readonly signingInLabel?: string;
}) {
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
              Connected
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Not connected</span>
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
              isConnected={props.isConnected}
              onConnected={props.onConnected}
              reconnectingLabel={props.reconnectingLabel}
              signingInLabel={props.signingInLabel}
            />
          </div>
        </div>
      </CredentialControlField>
    </CredentialUsageRow>
  );
}
