import { useMemo, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { graphqlSourceAtom, graphqlSourceBindingsAtom } from "./atoms";
import {
  configureSource,
  connectionsAtom,
  setSourceCredentialBinding,
} from "@executor-js/react/api/atoms";
import { useScope, useUserScope } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  httpCredentialsFromConfiguredCredentialBindings,
  serializeHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import { slugifyNamespace, useSourceIdentity } from "@executor-js/react/plugins/source-identity";
import { useCredentialTargetScope } from "@executor-js/react/plugins/credential-target-scope";
import {
  useSourceCredentialBindingScopes,
  useSourceCredentialBindingWriter,
} from "@executor-js/react/plugins/source-credential-bindings";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import { FilterTabs } from "@executor-js/react/components/filter-tabs";
import {
  SourceOAuthConnectionControl,
  sourceOAuthConnectionUiState,
} from "@executor-js/react/plugins/source-oauth-connection";
import { Badge } from "@executor-js/react/components/badge";
import { type CredentialBindingRef, ScopeId } from "@executor-js/sdk/shared";
import {
  SecretCredentialSlotBindings,
  secretCredentialSlotsFromHttpConfig,
} from "@executor-js/react/plugins/credential-slot-bindings";
import { GraphqlSourceFields } from "./GraphqlSourceFields";
import type { GraphqlSourceAuthInput } from "../sdk/types";
import type { StoredGraphqlSource } from "../sdk/store";

type EditableSource = StoredGraphqlSource;
type AuthMode = "none" | "oauth2";

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm(props: {
  sourceId: string;
  initial: EditableSource;
  bindings: readonly CredentialBindingRef[];
  onSave: () => void;
}) {
  const displayScope = useScope();
  const userScope = useUserScope();
  const sourceScope = ScopeId.make(props.initial.scope);
  const {
    credentialTargetScope: oauthCredentialTargetScope,
    setCredentialTargetScope: setOAuthCredentialTargetScope,
  } = useCredentialTargetScope({
    sourceScope,
    initialTargetScope: userScope,
  });
  const doConfigure = useAtomSet(configureSource, { mode: "promiseExit" });
  const setConnectionBinding = useAtomSet(setSourceCredentialBinding, { mode: "promise" });
  const secretList = useSecretPickerSecrets();
  const connectionsResult = useAtomValue(connectionsAtom(userScope));

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [endpoint, setEndpoint] = useState(props.initial.endpoint);
  const credentials = useMemo<HttpCredentialsState>(
    () =>
      httpCredentialsFromConfiguredCredentialBindings({
        headers: props.initial.headers,
        queryParams: props.initial.queryParams,
        bindings: props.bindings,
      }),
    [props.bindings, props.initial.headers, props.initial.queryParams],
  );
  const [authMode, setAuthMode] = useState<AuthMode>(props.initial.auth.kind);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authDirty, setAuthDirty] = useState(false);
  const { busyKey, setSecretBinding, clearBinding } = useSourceCredentialBindingWriter({
    displayScope,
    source: { id: props.sourceId, scope: sourceScope },
    onError: setError,
  });

  const identityDirty = identity.name.trim() !== props.initial.name.trim();
  const metadataDirty = identityDirty || endpoint.trim() !== props.initial.endpoint.trim();
  const dirty = metadataDirty || authDirty;
  const oauth2 = props.initial.auth.kind === "oauth2" ? props.initial.auth : null;
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
  const { credentialScopeOptions, secretBindingScopes, scopeRanks } =
    useSourceCredentialBindingScopes({ sourceScope });
  const secretSlots = secretCredentialSlotsFromHttpConfig({
    headers: props.initial.headers,
    queryParams: props.initial.queryParams,
  });
  const oauthConnectionState = oauth2
    ? sourceOAuthConnectionUiState({
        bindings: props.bindings,
        connectionSlot: oauth2.connectionSlot,
        tokenScope: oauthCredentialTargetScope,
        scopeRanks,
        credentialScopeOptions,
        connections,
      })
    : null;
  const oauthRequestCredentials = serializeHttpCredentials(credentials);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const config: {
      name?: string;
      endpoint?: string;
      auth?: GraphqlSourceAuthInput;
    } = {
      name: metadataDirty ? identity.name.trim() || undefined : undefined,
      endpoint: metadataDirty ? endpoint.trim() || undefined : undefined,
    };
    if (authDirty) {
      config.auth = authMode === "oauth2" ? { oauth2: {} } : { kind: "none" };
    }
    const exit = await doConfigure({
      params: { scopeId: displayScope },
      payload: {
        source: { id: props.sourceId, scope: sourceScope },
        scope: sourceScope,
        type: "graphql",
        config,
      },
      reactivityKeys: sourceWriteKeys,
    });

    if (Exit.isFailure(exit)) {
      setError("Failed to update source");
      setSaving(false);
      return;
    }

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

      {secretSlots.length > 0 && (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntry>
              <CardStackEntryContent>
                <CardStackEntryTitle>Request credentials</CardStackEntryTitle>
                <CardStackEntryDescription>
                  Headers and query parameters sent with every GraphQL request.
                </CardStackEntryDescription>
              </CardStackEntryContent>
            </CardStackEntry>
            <SecretCredentialSlotBindings
              slots={secretSlots}
              bindingScopes={secretBindingScopes}
              bindingRows={props.bindings}
              scopeRanks={scopeRanks}
              secrets={secretList}
              sourceId={props.sourceId}
              sourceName={identity.name}
              credentialScopeOptions={credentialScopeOptions}
              busyKey={busyKey}
              onSetSecretBinding={setSecretBinding}
              onClearBinding={clearBinding}
            />
          </CardStackContent>
        </CardStack>
      )}

      {/* Temporarily hidden while we revisit GraphQL OAuth discovery and UX. */}
      <section className="hidden space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">Authentication</span>
          <FilterTabs<AuthMode>
            tabs={[
              { value: "none", label: "None" },
              { value: "oauth2", label: "OAuth" },
            ]}
            value={authMode}
            onChange={(value) => {
              setAuthMode(value);
              setAuthDirty(true);
            }}
          />
        </div>
        {authMode === "oauth2" && (
          <p className="text-xs text-muted-foreground">
            OAuth sign-in is available from the source header after saving.
          </p>
        )}
      </section>

      {oauth2 && oauthConnectionState && (
        <SourceOAuthConnectionControl
          popupName="graphql-oauth"
          pluginId="graphql"
          namespace={slugifyNamespace(props.initial.namespace) || "graphql"}
          fallbackNamespace="graphql"
          endpoint={endpoint.trim()}
          tokenScope={oauthCredentialTargetScope}
          onTokenScopeChange={setOAuthCredentialTargetScope}
          credentialScopeOptions={credentialScopeOptions}
          connectionId={oauthConnectionState.connectionId}
          sourceLabel={`${identity.name.trim() || props.initial.namespace || "GraphQL"} OAuth`}
          headers={oauthRequestCredentials.headers}
          queryParams={oauthRequestCredentials.queryParams}
          isConnected={oauthConnectionState.isConnected}
          buttonIsConnected={oauthConnectionState.buttonIsConnected}
          statusLabel={oauthConnectionState.statusLabel}
          onConnected={async (connectionId) => {
            await setConnectionBinding({
              params: { scopeId: oauthCredentialTargetScope },
              payload: {
                scope: oauthCredentialTargetScope,
                source: { id: props.sourceId, scope: sourceScope },
                slotKey: oauth2.connectionSlot,
                value: { kind: "connection", connectionId },
              },
              reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
            });
          }}
          signInLabel={oauthConnectionState.signInLabel}
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
  const userScope = useUserScope();
  const sourceResult = useAtomValue(graphqlSourceAtom(scopeId, props.sourceId));
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : scopeId;
  const bindingsResult = useAtomValue(
    graphqlSourceBindingsAtom(userScope, props.sourceId, sourceScope),
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
