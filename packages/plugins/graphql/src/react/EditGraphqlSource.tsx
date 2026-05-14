import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { graphqlSourceAtom, updateGraphqlSource } from "./atoms";
import { sourceCredentialBindingsAtom } from "@executor-js/react/api/atoms";
import { useScope } from "@executor-js/react/api/scope-context";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  HttpCredentialEditor,
  useHttpCredentialEditorController,
} from "@executor-js/react/plugins/http-credential-state";
import {
  httpCredentialsFromConfiguredCredentialBindings,
  initialCredentialTargetScope,
} from "@executor-js/react/plugins/credential-bindings";
import { slugifyNamespace, useSourceIdentity } from "@executor-js/react/plugins/source-identity";
import { useCredentialTargetScope } from "@executor-js/react/plugins/credential-target-scope";
import { Button } from "@executor-js/react/components/button";
import {
  SourceOAuthConnectionControl,
  useSourceOAuthConnectionBinding,
} from "@executor-js/react/plugins/source-oauth-connection";
import { Badge } from "@executor-js/react/components/badge";
import { ScopeId } from "@executor-js/sdk/core";
import type { SourceCredentialBindingRef } from "@executor-js/react/plugins/credential-bindings";
import { GraphqlSourceFields } from "./GraphqlSourceFields";
import { GRAPHQL_OAUTH_CONNECTION_SLOT, type GraphqlCredentialInput } from "../sdk/types";
import type { StoredGraphqlSource } from "../sdk/store";

type EditableSource = StoredGraphqlSource;
type AuthMode = "none" | "oauth2";

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm(props: {
  sourceId: string;
  initial: EditableSource;
  bindings: readonly SourceCredentialBindingRef[];
  onSave: () => void;
}) {
  const displayScope = useScope();
  const sourceScope = ScopeId.make(props.initial.scope);
  const { credentialTargetScope, credentialScopeOptions } = useCredentialTargetScope({
    sourceScope,
    initialTargetScope: initialCredentialTargetScope(sourceScope, props.bindings),
  });
  const {
    credentialTargetScope: oauthCredentialTargetScope,
    setCredentialTargetScope: setOAuthCredentialTargetScope,
  } = useCredentialTargetScope({
    sourceScope,
    initialTargetScope: initialCredentialTargetScope(sourceScope, props.bindings),
  });
  const doUpdate = useAtomSet(updateGraphqlSource, { mode: "promiseExit" });
  const secretList = useSecretPickerSecrets();
  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const credentialEditor = useHttpCredentialEditorController({
    initialCredentials: httpCredentialsFromConfiguredCredentialBindings({
      headers: props.initial.headers,
      queryParams: props.initial.queryParams,
      bindings: props.bindings,
    }),
    targetScope: credentialTargetScope,
    existingSecrets: secretList,
    sourceName: identity.name,
    credentialScopeOptions,
    bindingScopeOptions: credentialScopeOptions,
  });

  const [endpoint, setEndpoint] = useState(props.initial.endpoint);
  const [authMode, setAuthMode] = useState<AuthMode>(props.initial.auth.kind);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authDirty, setAuthDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();
  const metadataDirty = identityDirty || endpoint.trim() !== props.initial.endpoint.trim();
  const dirty = metadataDirty || credentialEditor.state.dirty || authDirty;
  const oauth2 = props.initial.auth.kind === "oauth2" ? props.initial.auth : null;
  const oauthConnection = useSourceOAuthConnectionBinding({
    pluginId: "graphql",
    sourceId: props.sourceId,
    sourceScope,
    slotKey: oauth2?.connectionSlot ?? GRAPHQL_OAUTH_CONNECTION_SLOT,
    targetScope: oauthCredentialTargetScope,
    bindings: props.bindings,
  });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const { headers, queryParams } = credentialEditor.serialized.scoped;
    const payload: {
      sourceScope: ScopeId;
      name?: string;
      endpoint?: string;
      headers?: Record<string, GraphqlCredentialInput>;
      queryParams?: Record<string, GraphqlCredentialInput>;
      credentialTargetScope?: ScopeId;
      auth?: { kind: "none" } | { kind: "oauth2"; connectionSlot: string };
    } = {
      sourceScope,
      name: metadataDirty ? identity.name.trim() || undefined : undefined,
      endpoint: metadataDirty ? endpoint.trim() || undefined : undefined,
    };
    if (credentialEditor.state.dirty) {
      payload.headers = headers;
      payload.queryParams = queryParams as Record<string, GraphqlCredentialInput>;
      payload.credentialTargetScope = credentialEditor.state.targetScope;
    }
    if (authDirty) {
      payload.auth =
        authMode === "oauth2"
          ? {
              kind: "oauth2",
              connectionSlot:
                props.initial.auth.kind === "oauth2"
                  ? props.initial.auth.connectionSlot
                  : GRAPHQL_OAUTH_CONNECTION_SLOT,
            }
          : { kind: "none" };
      payload.credentialTargetScope = credentialEditor.state.targetScope;
    }
    const exit = await doUpdate({
      params: { scopeId: displayScope, namespace: props.sourceId },
      payload,
      reactivityKeys: sourceWriteKeys,
    });

    if (Exit.isFailure(exit)) {
      setError("Failed to update source");
      setSaving(false);
      return;
    }

    credentialEditor.actions.resetDirty();
    setAuthDirty(false);
    props.onSave();
    setSaving(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit GraphQL Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the endpoint and authentication headers for this source.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          GraphQL
        </Badge>
      </div>

      <GraphqlSourceFields
        endpoint={endpoint}
        onEndpointChange={setEndpoint}
        identity={identity}
        namespaceReadOnly
      />

      <HttpCredentialEditor.Provider controller={credentialEditor}>
        <HttpCredentialEditor.Headers />
        <HttpCredentialEditor.QueryParams />
      </HttpCredentialEditor.Provider>

      {/* Temporarily hidden while we revisit GraphQL OAuth discovery and UX. */}
      <section className="hidden space-y-2.5">
        <HttpCredentialEditor.Auth.Root
          label="Authentication"
          value={authMode}
          onValueChange={(value) => {
            setAuthMode(value === "oauth2" ? "oauth2" : "none");
            setAuthDirty(true);
          }}
        >
          <HttpCredentialEditor.Auth.None />
          <HttpCredentialEditor.Auth.OAuth value="oauth2" label="OAuth" />
        </HttpCredentialEditor.Auth.Root>
        {authMode === "oauth2" && (
          <p className="text-xs text-muted-foreground">
            OAuth sign-in is available from the source header after saving.
          </p>
        )}
      </section>

      {oauth2 && (
        <SourceOAuthConnectionControl
          popupName="graphql-oauth"
          pluginId="graphql"
          namespace={slugifyNamespace(props.initial.namespace) || "graphql"}
          fallbackNamespace="graphql"
          endpoint={endpoint.trim()}
          tokenScope={oauthCredentialTargetScope}
          onTokenScopeChange={setOAuthCredentialTargetScope}
          credentialScopeOptions={credentialScopeOptions}
          connectionId={oauthConnection.connectionId}
          sourceLabel={`${identity.name.trim() || props.initial.namespace || "GraphQL"} OAuth`}
          headers={credentialEditor.serialized.request.headers}
          queryParams={credentialEditor.serialized.request.queryParams}
          isConnected={oauthConnection.isConnected}
          onConnected={oauthConnection.onConnected}
        />
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditGraphqlSource(props: { sourceId: string; onSave: () => void }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(graphqlSourceAtom(scopeId, props.sourceId));
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : scopeId;
  const bindingsResult = useAtomValue(
    sourceCredentialBindingsAtom(scopeId, "graphql", props.sourceId, sourceScope),
  );

  if (!AsyncResult.isSuccess(sourceResult) || !source || !AsyncResult.isSuccess(bindingsResult)) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit GraphQL Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  return (
    <EditForm
      sourceId={props.sourceId}
      initial={source as EditableSource}
      bindings={bindingsResult.value}
      onSave={props.onSave}
    />
  );
}
