import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAtom, sourceAtom } from "@executor-js/react/api/atoms";
import { Badge } from "@executor-js/react/components/badge";
import { useScope, useScopeStack, useUserScope } from "@executor-js/react/api/scope-context";
import { ScopeId } from "@executor-js/sdk/core";
import {
  SourceCredentialNotice,
  SourceCredentialStatusBadge,
  missingSourceCredentialLabels,
  type SourceCredentialSlot,
} from "@executor-js/react/plugins/source-credential-status";

import { openApiSourceAtom, openApiSourceBindingsAtom } from "./atoms";
import { effectiveBindingForScope } from "../sdk/credential-status";
import { oauth2ClientSecretSlot, type StoredSourceSchemaType } from "../sdk/store";

function OAuthBadge() {
  return <Badge variant="secondary">OAuth</Badge>;
}

function CheckingCredentialsBadge() {
  return (
    <Badge
      variant="outline"
      className="border-border bg-muted/50 text-[10px] text-muted-foreground"
    >
      Checking credentials
    </Badge>
  );
}

const effectiveClientSecretSlot = (oauth2: {
  readonly securitySchemeName: string;
  readonly clientSecretSlot: string | null;
}): string => oauth2.clientSecretSlot ?? oauth2ClientSecretSlot(oauth2.securitySchemeName);

const sourceCredentialSlots = (source: StoredSourceSchemaType): readonly SourceCredentialSlot[] => {
  const slots: SourceCredentialSlot[] = [];
  for (const [name, value] of Object.entries(source.config.headers ?? {})) {
    if (typeof value !== "string") slots.push({ kind: "secret", slot: value.slot, label: name });
  }
  for (const [name, value] of Object.entries(source.config.queryParams ?? {})) {
    if (typeof value !== "string") slots.push({ kind: "secret", slot: value.slot, label: name });
  }
  const oauth2 = source.config.oauth2;
  if (oauth2) {
    slots.push({ kind: "secret", slot: oauth2.clientIdSlot, label: "Client ID" });
    slots.push({
      kind: "secret",
      slot: effectiveClientSecretSlot(oauth2),
      label: "Client Secret",
    });
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
    return props.variant === "panel" ? null : <CheckingCredentialsBadge />;
  }

  const bindings = AsyncResult.isSuccess(bindingsResult) ? bindingsResult.value : [];
  if (oauth2 && !connectionsLoaded) {
    return props.variant === "panel" ? null : <CheckingCredentialsBadge />;
  }
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
  const liveConnectionIds = new Set(connections.map((connection) => connection.id));
  const scopeRanks = new Map(scopeStack.map((scope, index) => [scope.id, index] as const));
  const credentialTargetScope = userScope;
  const missing = missingSourceCredentialLabels({
    slots: sourceCredentialSlots(source),
    bindings,
    targetScope: credentialTargetScope,
    scopeRanks,
    liveConnectionIds,
  });

  if (props.variant === "panel") {
    return <SourceCredentialNotice missing={missing} onAction={props.onAction} />;
  }

  if (missing.length > 0) return <SourceCredentialStatusBadge missing={missing} />;

  if (!oauth2) return null;
  const connectionBinding = effectiveBindingForScope(
    bindings,
    oauth2.connectionSlot,
    credentialTargetScope,
    scopeRanks,
  );
  const connectionId =
    connectionBinding && connectionBinding.value.kind === "connection"
      ? connectionBinding.value.connectionId
      : null;

  if (connectionId && connections.some((connection) => connection.id === connectionId)) {
    return <SourceCredentialStatusBadge missing={[]} />;
  }

  return <OAuthBadge />;
}
