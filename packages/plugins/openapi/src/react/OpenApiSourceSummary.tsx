import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionIdentityAtom, connectionsAtom, sourceAtom } from "@executor-js/react/api/atoms";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { useScope, useScopeStack, useUserScope } from "@executor-js/react/api/scope-context";
import { ConnectionId, ScopeId } from "@executor-js/sdk/shared";
import {
  SourceCredentialLoadingBadge,
  SourceCredentialNotice,
  SourceCredentialStatusBadge,
  missingSourceCredentialLabels,
  type SourceCredentialSlot,
} from "@executor-js/react/plugins/source-credential-status";

import { openApiSourceAtom, openApiSourceBindingsAtom } from "./atoms";
import { effectiveBindingForScope } from "../sdk/credential-status";
import { oauth2ClientSecretSlot, type StoredSourceSchemaType } from "../sdk/source-contracts";

function OAuthBadge() {
  return <Badge variant="secondary">OAuth</Badge>;
}

function SourceAccountNotice(props: {
  readonly connection: {
    readonly id: string;
    readonly scopeId: string;
    readonly identityLabel: string | null;
  };
  readonly onAction?: () => void;
}) {
  const identityResult = useAtomValue(
    connectionIdentityAtom(
      ScopeId.make(props.connection.scopeId),
      ConnectionId.make(props.connection.id),
    ),
  );
  const identity =
    AsyncResult.isSuccess(identityResult) && identityResult.value.status === "available"
      ? identityResult.value
      : null;
  const label = identity?.email ?? identity?.name ?? props.connection.identityLabel ?? "Connected";
  return (
    <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-3">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          {identity?.picture ? (
            <img
              src={identity.picture}
              alt=""
              referrerPolicy="no-referrer"
              className="size-6 shrink-0 rounded-full"
            />
          ) : (
            <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
              {label.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{label}</div>
            <div className="text-xs text-muted-foreground">OAuth account for this source</div>
          </div>
        </div>
        {props.onAction ? (
          <Button variant="ghost" size="sm" onClick={props.onAction} className="shrink-0">
            Configure
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const effectiveClientSecretSlot = (oauth2: {
  readonly securitySchemeName: string;
  readonly clientSecretSlot: string | null;
}): string => oauth2.clientSecretSlot ?? oauth2ClientSecretSlot(oauth2.securitySchemeName);

const sourceCredentialSlots = (
  source: StoredSourceSchemaType,
  options?: { readonly hasLiveOAuthConnection?: boolean },
): readonly SourceCredentialSlot[] => {
  const slots: SourceCredentialSlot[] = [];
  for (const [name, value] of Object.entries(source.config.headers ?? {})) {
    if (typeof value !== "string") slots.push({ kind: "secret", slot: value.slot, label: name });
  }
  for (const [name, value] of Object.entries(source.config.queryParams ?? {})) {
    if (typeof value !== "string") slots.push({ kind: "secret", slot: value.slot, label: name });
  }
  const oauth2 = source.config.oauth2;
  if (oauth2) {
    if (!options?.hasLiveOAuthConnection) {
      slots.push({ kind: "secret", slot: oauth2.clientIdSlot, label: "Client ID" });
      slots.push({
        kind: "secret",
        slot: effectiveClientSecretSlot(oauth2),
        label: "Client Secret",
      });
    }
    slots.push({
      kind: "connection",
      slot: oauth2.connectionSlot,
      label: oauth2.flow === "clientCredentials" ? "OAuth client connection" : "OAuth sign-in",
    });
  }
  return slots;
};

// The entry row already renders name + id + kind, so this summary
// component only contributes extras — specifically, an OAuth status
// badge when the source has OAuth2 configured. Non-OAuth sources
// render nothing.
export default function OpenApiSourceSummary(props: {
  sourceId: string;
  variant?: "badge" | "panel";
  onAction?: () => void;
}) {
  const displayScope = useScope();
  const userScope = useUserScope();
  const scopeStack = useScopeStack();
  const summaryResult = useAtomValue(sourceAtom(props.sourceId, displayScope));
  const sourceScopeId =
    AsyncResult.isSuccess(summaryResult) && summaryResult.value?.scopeId
      ? summaryResult.value.scopeId
      : displayScope;
  const sourceResult = useAtomValue(openApiSourceAtom(ScopeId.make(sourceScopeId), props.sourceId));
  const bindingsResult = useAtomValue(
    openApiSourceBindingsAtom(displayScope, props.sourceId, ScopeId.make(sourceScopeId)),
  );
  const connectionsResult = useAtomValue(connectionsAtom(displayScope));

  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;

  if (!source) return null;
  const oauth2 = source.config.oauth2;
  const bindingsLoaded = AsyncResult.isSuccess(bindingsResult);
  const connectionsLoaded = AsyncResult.isSuccess(connectionsResult);
  if (!bindingsLoaded) {
    return props.variant === "panel" ? null : <SourceCredentialLoadingBadge />;
  }

  const bindings = AsyncResult.isSuccess(bindingsResult) ? bindingsResult.value : [];
  if (oauth2 && !connectionsLoaded) {
    return props.variant === "panel" ? null : <SourceCredentialLoadingBadge />;
  }
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
  const liveConnectionIds = new Set(connections.map((connection) => connection.id));
  const scopeRanks = new Map(scopeStack.map((scope, index) => [scope.id, index] as const));
  const credentialTargetScope = userScope;
  const connectionBinding = effectiveBindingForScope(
    bindings,
    oauth2?.connectionSlot ?? "",
    credentialTargetScope,
    scopeRanks,
  );
  const connectionId =
    connectionBinding && connectionBinding.value.kind === "connection"
      ? connectionBinding.value.connectionId
      : null;
  const connection = connectionId
    ? (connections.find((candidate) => candidate.id === connectionId) ?? null)
    : null;
  const missing = missingSourceCredentialLabels({
    slots: sourceCredentialSlots(source, { hasLiveOAuthConnection: connection !== null }),
    bindings,
    targetScope: credentialTargetScope,
    scopeRanks,
    liveConnectionIds,
  });

  if (props.variant === "panel") {
    if (missing.length > 0)
      return <SourceCredentialNotice missing={missing} onAction={props.onAction} />;
    return connection ? (
      <SourceAccountNotice connection={connection} onAction={props.onAction} />
    ) : null;
  }

  if (missing.length > 0) return <SourceCredentialStatusBadge missing={missing} />;

  if (!oauth2) return null;

  if (connection) {
    return <SourceCredentialStatusBadge missing={[]} />;
  }

  return <OAuthBadge />;
}
