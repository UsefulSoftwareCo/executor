import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { connectionsAtom } from "@executor-js/react/api/atoms";
import { useScope, useUserScope } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { SourceOAuthSignInButton } from "@executor-js/react/plugins/oauth-sign-in";
import { slugifyNamespace } from "@executor-js/react/plugins/source-identity";
import { secretBackedValuesFromConfiguredCredentialBindings } from "@executor-js/react/plugins/credential-bindings";
import { ScopeId } from "@executor-js/sdk/core";

import { graphqlSourceAtom, graphqlSourceBindingsAtom, setGraphqlSourceBinding } from "./atoms";

export default function GraphqlSignInButton(props: { sourceId: string }) {
  const scopeId = useScope();
  const userScopeId = useUserScope();
  const sourceResult = useAtomValue(graphqlSourceAtom(scopeId, props.sourceId));
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : scopeId;
  const bindingsResult = useAtomValue(
    graphqlSourceBindingsAtom(scopeId, props.sourceId, sourceScope),
  );
  const connectionsResult = useAtomValue(connectionsAtom(scopeId));
  const setBinding = useAtomSet(setGraphqlSourceBinding, { mode: "promise" });

  const oauth2 = source?.auth.kind === "oauth2" ? source.auth : null;
  const bindings = AsyncResult.isSuccess(bindingsResult) ? bindingsResult.value : null;
  const connectionBinding = bindings?.find(
    (binding) => oauth2 !== null && binding.slot === oauth2.connectionSlot,
  );
  const boundConnectionId =
    connectionBinding?.value.kind === "connection" ? connectionBinding.value.connectionId : null;
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : null;
  const isConnected =
    boundConnectionId !== null &&
    connections !== null &&
    connections.some((c: { readonly id: string }) => c.id === boundConnectionId);

  if (!source || !oauth2) return null;
  const namespaceSlug = slugifyNamespace(source.namespace) || "graphql";

  return (
    <SourceOAuthSignInButton
      popupName="graphql-oauth"
      pluginId="graphql"
      namespace={namespaceSlug}
      fallbackNamespace="graphql"
      endpoint={source.endpoint}
      tokenScope={userScopeId}
      connectionId={boundConnectionId}
      sourceLabel={`${source.name.trim() || source.namespace || "GraphQL"} OAuth`}
      headers={secretBackedValuesFromConfiguredCredentialBindings(source.headers, bindings ?? [])}
      queryParams={secretBackedValuesFromConfiguredCredentialBindings(
        source.queryParams,
        bindings ?? [],
      )}
      isConnected={isConnected}
      onConnected={async (connectionId) => {
        await setBinding({
          params: { scopeId },
          payload: {
            sourceId: props.sourceId,
            sourceScope,
            scope: userScopeId,
            slot: oauth2.connectionSlot,
            value: { kind: "connection", connectionId },
          },
          reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
        });
      }}
    />
  );
}
