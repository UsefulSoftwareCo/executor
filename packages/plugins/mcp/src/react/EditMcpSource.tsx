import { useMemo, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { mcpSourceAtom, mcpSourceBindingsAtom } from "./atoms";
import {
  configureSource,
  connectionsAtom,
  setSourceCredentialBinding,
} from "@executor-js/react/api/atoms";
import { useScope, useUserScope } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { slugifyNamespace, useSourceIdentity } from "@executor-js/react/plugins/source-identity";
import { useCredentialTargetScope } from "@executor-js/react/plugins/credential-target-scope";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  httpCredentialsFromConfiguredCredentialBindings,
  serializeHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import {
  useSourceCredentialBindingScopes,
  useSourceCredentialBindingWriter,
} from "@executor-js/react/plugins/source-credential-bindings";
import {
  SourceOAuthConnectionControl,
  sourceOAuthConnectionUiState,
} from "@executor-js/react/plugins/source-oauth-connection";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import { Badge } from "@executor-js/react/components/badge";
import { type CredentialBindingRef, ScopeId } from "@executor-js/sdk/shared";
import {
  SecretCredentialSlotBindings,
  secretCredentialSlotsFromHttpConfig,
} from "@executor-js/react/plugins/credential-slot-bindings";
import { McpRemoteSourceFields } from "./McpRemoteSourceFields";
import type { McpStoredSourceSchemaType } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// Remote edit form
// ---------------------------------------------------------------------------

function RemoteEditForm(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "remote" } };
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
  const [endpoint, setEndpoint] = useState(props.initial.config.endpoint);
  const credentials = useMemo<HttpCredentialsState>(
    () =>
      httpCredentialsFromConfiguredCredentialBindings({
        headers: props.initial.config.headers,
        queryParams: props.initial.config.queryParams,
        bindings: props.bindings,
      }),
    [props.bindings, props.initial.config.headers, props.initial.config.queryParams],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busyKey, setSecretBinding, clearBinding } = useSourceCredentialBindingWriter({
    displayScope,
    source: { id: props.sourceId, scope: sourceScope },
    onError: setError,
  });

  const identityDirty = identity.name.trim() !== props.initial.name.trim();
  const metadataDirty = identityDirty || endpoint.trim() !== props.initial.config.endpoint.trim();
  const dirty = metadataDirty;
  const oauth2 = props.initial.config.auth.kind === "oauth2" ? props.initial.config.auth : null;
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
  const { credentialScopeOptions, secretBindingScopes, scopeRanks } =
    useSourceCredentialBindingScopes({ sourceScope });
  const secretSlots = secretCredentialSlotsFromHttpConfig({
    headers: props.initial.config.headers,
    queryParams: props.initial.config.queryParams,
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
    } = {
      name: metadataDirty ? identity.name.trim() || undefined : undefined,
      endpoint: metadataDirty ? endpoint.trim() || undefined : undefined,
    };
    const exit = await doConfigure({
      params: { scopeId: displayScope },
      payload: {
        source: { id: props.sourceId, scope: sourceScope },
        scope: sourceScope,
        type: "mcp",
        config,
      },
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError("Failed to update source");
      setSaving(false);
      return;
    }
    setSaving(false);
    props.onSave();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the endpoint and headers for this MCP connection.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          remote
        </Badge>
      </div>

      <McpRemoteSourceFields
        url={endpoint}
        onUrlChange={setEndpoint}
        identity={identity}
        preview={{
          name: props.initial.name,
          serverName: props.initial.name,
          connected: true,
          toolCount: null,
        }}
        namespaceReadOnly
      />

      {secretSlots.length > 0 && (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntry>
              <CardStackEntryContent>
                <CardStackEntryTitle>Request credentials</CardStackEntryTitle>
                <CardStackEntryDescription>
                  Headers and query parameters sent with every MCP request.
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

      {oauth2 && oauthConnectionState && (
        <SourceOAuthConnectionControl
          popupName="mcp-oauth"
          pluginId="mcp"
          namespace={slugifyNamespace(props.initial.namespace) || "mcp"}
          fallbackNamespace="mcp"
          endpoint={endpoint.trim()}
          tokenScope={oauthCredentialTargetScope}
          onTokenScopeChange={setOAuthCredentialTargetScope}
          credentialScopeOptions={credentialScopeOptions}
          connectionId={oauthConnectionState.connectionId}
          sourceLabel={`${identity.name.trim() || props.initial.namespace || "MCP"} OAuth`}
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
          reconnectingLabel="Reconnecting…"
          reconnectLabel="Reconnect"
          signInLabel={oauthConnectionState.signInLabel}
          signingInLabel="Signing in…"
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
// Stdio read-only view
// ---------------------------------------------------------------------------

function StdioReadOnly(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "stdio" } };
  onSave: () => void;
}) {
  const { command, args } = props.initial.config;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stdio MCP sources cannot be edited in the UI. Remove and recreate the source with the
          updated command.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
          <p className="mt-0.5 text-xs text-muted-foreground font-mono">
            {command} {(args ?? []).join(" ")}
          </p>
        </div>
        <Badge variant="secondary" className="text-xs">
          stdio
        </Badge>
      </div>

      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button onClick={props.onSave}>Done</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditMcpSource({
  sourceId,
  onSave,
}: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const scopeId = useScope();
  const userScope = useUserScope();
  const sourceResult = useAtomValue(mcpSourceAtom(scopeId, sourceId)) as AsyncResult.AsyncResult<
    McpStoredSourceSchemaType | null,
    unknown
  >;
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : scopeId;
  const bindingsResult = useAtomValue(mcpSourceBindingsAtom(userScope, sourceId, sourceScope));

  if (!AsyncResult.isSuccess(sourceResult) || !source || !AsyncResult.isSuccess(bindingsResult)) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  if (source.config.transport === "stdio") {
    return (
      <StdioReadOnly
        sourceId={sourceId}
        initial={source as McpStoredSourceSchemaType & { config: { transport: "stdio" } }}
        onSave={onSave}
      />
    );
  }

  return (
    <RemoteEditForm
      sourceId={sourceId}
      initial={source as McpStoredSourceSchemaType & { config: { transport: "remote" } }}
      bindings={bindingsResult.value}
      onSave={onSave}
    />
  );
}
