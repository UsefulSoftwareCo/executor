import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { ScopeId } from "@executor-js/sdk/core";
import { useScope, useUserScope } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { connectionsAtom } from "@executor-js/react/api/atoms";
import { SourceOAuthSignInButton } from "@executor-js/react/plugins/oauth-sign-in";
import { slugifyNamespace } from "@executor-js/react/plugins/source-identity";
import { secretBackedValuesFromConfiguredCredentialBindings } from "@executor-js/react/plugins/credential-bindings";

import { mcpSourceAtom, mcpSourceBindingsAtom, setMcpSourceBinding } from "./atoms";
import type { McpStoredSourceSchemaType } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// McpSignInButton — top-bar action on the source detail page.
//
// Reads the source's stored endpoint + oauth2 slot, re-runs the DCR /
// authorization-code flow against a stable `mcp-oauth2-${namespace}`
// connection id, and on success writes the user's credential binding.
// ---------------------------------------------------------------------------

export default function McpSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const userScopeId = useUserScope();
  const sourceResult = useAtomValue(
    mcpSourceAtom(scopeId, props.sourceId),
  ) as AsyncResult.AsyncResult<McpStoredSourceSchemaType | null, unknown>;
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : scopeId;
  const bindingsResult = useAtomValue(mcpSourceBindingsAtom(scopeId, props.sourceId, sourceScope));
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const setBinding = useAtomSet(setMcpSourceBinding, { mode: "promise" });

  const remote = source && source.config.transport === "remote" ? source.config : null;
  const oauth2 = remote && remote.auth.kind === "oauth2" ? remote.auth : null;
  const connections = AsyncResult.isSuccess(connectionsResult)
    ? (connectionsResult.value as readonly { readonly id: string }[])
    : null;
  const bindings = AsyncResult.isSuccess(bindingsResult) ? bindingsResult.value : null;
  const connectionBinding = bindings?.find(
    (binding) => binding.slot === oauth2?.connectionSlot && binding.value.kind === "connection",
  );
  const connectionId =
    connectionBinding?.value.kind === "connection" ? connectionBinding.value.connectionId : null;
  const isConnected =
    oauth2 !== null &&
    connections !== null &&
    connectionId !== null &&
    connections.some((c) => c.id === connectionId);

  if (!remote || !oauth2 || !source) return null;
  const namespaceSlug = slugifyNamespace(source.namespace) || "mcp";

  return (
    <SourceOAuthSignInButton
      popupName="mcp-oauth"
      pluginId="mcp"
      namespace={namespaceSlug}
      fallbackNamespace="mcp"
      endpoint={remote.endpoint}
      tokenScope={userScopeId}
      connectionId={connectionId}
      sourceLabel={`${source.name.trim() || source.namespace || "MCP"} OAuth`}
      headers={secretBackedValuesFromConfiguredCredentialBindings(remote.headers, bindings ?? [])}
      queryParams={secretBackedValuesFromConfiguredCredentialBindings(
        remote.queryParams,
        bindings ?? [],
      )}
      isConnected={isConnected}
      onConnected={async (nextConnectionId) => {
        await setBinding({
          params: { scopeId },
          payload: {
            sourceId: props.sourceId,
            sourceScope,
            scope: userScopeId,
            slot: oauth2.connectionSlot,
            value: { kind: "connection", connectionId: nextConnectionId },
          },
          reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
        });
      }}
      reconnectingLabel="Reconnecting…"
      signingInLabel="Signing in…"
    />
  );
}
