import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAtom } from "@executor-js/react/api/atoms";
import { useScope, useScopeStack, useUserScope } from "@executor-js/react/api/scope-context";
import { Button } from "@executor-js/react/components/button";
import {
  SourceCredentialNotice,
  SourceCredentialStatusBadge,
  missingSourceCredentialLabels,
  type SourceCredentialSlot,
} from "@executor-js/react/plugins/source-credential-status";
import { ScopeId } from "@executor-js/sdk/shared";

import { mcpSourceAtom, mcpSourceBindingsAtom } from "./atoms";
import McpSignInButton from "./McpSignInButton";
import type { McpStoredSourceSchemaType } from "../sdk/stored-source";

const sourceCredentialSlots = (
  source: McpStoredSourceSchemaType,
): readonly SourceCredentialSlot[] => {
  if (source.config.transport !== "remote") return [];
  const slots: SourceCredentialSlot[] = [];
  for (const [name, value] of Object.entries(source.config.headers ?? {})) {
    if (typeof value !== "string") slots.push({ kind: "secret", slot: value.slot, label: name });
  }
  for (const [name, value] of Object.entries(source.config.queryParams ?? {})) {
    if (typeof value !== "string") slots.push({ kind: "secret", slot: value.slot, label: name });
  }
  const auth = source.config.auth;
  if (auth.kind === "header") {
    slots.push({
      kind: "secret",
      slot: auth.secretSlot,
      label: auth.headerName,
    });
  }
  if (auth.kind === "oauth2") {
    if (auth.clientIdSlot) {
      slots.push({ kind: "secret", slot: auth.clientIdSlot, label: "Client ID" });
    }
    if (auth.clientSecretSlot) {
      slots.push({ kind: "secret", slot: auth.clientSecretSlot, label: "Client Secret" });
    }
    slots.push({
      kind: "connection",
      slot: auth.connectionSlot,
      label: "OAuth sign-in",
    });
  }
  return slots;
};

export default function McpSourceSummary(props: {
  readonly sourceId: string;
  readonly variant?: "badge" | "panel";
  readonly onAction?: () => void;
}) {
  const displayScope = useScope();
  const userScope = useUserScope();
  const scopeStack = useScopeStack();
  const sourceResult = useAtomValue(mcpSourceAtom(displayScope, props.sourceId));
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : displayScope;
  const bindingsResult = useAtomValue(
    mcpSourceBindingsAtom(userScope, props.sourceId, sourceScope),
  );
  const connectionsResult = useAtomValue(connectionsAtom(userScope));

  if (!source) return null;
  const slots = sourceCredentialSlots(source as McpStoredSourceSchemaType);
  if (slots.length === 0) return null;
  if (!AsyncResult.isSuccess(bindingsResult) || !AsyncResult.isSuccess(connectionsResult)) {
    return props.variant === "panel" ? null : (
      <SourceCredentialStatusBadge missing={["credentials"]} />
    );
  }

  const scopeRanks = new Map(scopeStack.map((scope, index) => [scope.id, index] as const));
  const liveConnectionIds = new Set(connectionsResult.value.map((connection) => connection.id));
  const missing = missingSourceCredentialLabels({
    slots,
    bindings: bindingsResult.value,
    targetScope: userScope,
    scopeRanks,
    liveConnectionIds,
  });

  if (props.variant === "panel") {
    const needsOAuth = missing.includes("OAuth sign-in");
    const needsConfiguration = missing.some((label) => label !== "OAuth sign-in");
    return (
      <SourceCredentialNotice
        missing={missing}
        action={
          <div className="flex shrink-0 items-center gap-2">
            {needsOAuth && <McpSignInButton sourceId={props.sourceId} />}
            {needsConfiguration && props.onAction && (
              <Button type="button" size="sm" variant="outline" onClick={props.onAction}>
                Configure
              </Button>
            )}
          </div>
        }
      />
    );
  }

  return <SourceCredentialStatusBadge missing={missing} />;
}
