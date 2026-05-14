import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { mcpSourceAtom, updateMcpSource } from "./atoms";
import { sourceCredentialBindingsAtom } from "@executor-js/react/api/atoms";
import { useScope } from "@executor-js/react/api/scope-context";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { slugifyNamespace, useSourceIdentity } from "@executor-js/react/plugins/source-identity";
import { useCredentialTargetScope } from "@executor-js/react/plugins/credential-target-scope";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  HttpCredentialEditor,
  useHttpCredentialEditorController,
} from "@executor-js/react/plugins/http-credential-state";
import {
  httpCredentialsFromConfiguredCredentialBindings,
  initialCredentialTargetScope,
} from "@executor-js/react/plugins/credential-bindings";
import {
  SourceOAuthConnectionControl,
  useSourceOAuthConnectionBinding,
} from "@executor-js/react/plugins/source-oauth-connection";
import { Button } from "@executor-js/react/components/button";
import { Badge } from "@executor-js/react/components/badge";
import { ScopeId } from "@executor-js/sdk/core";
import type { SourceCredentialBindingRef } from "@executor-js/react/plugins/credential-bindings";
import { McpRemoteSourceFields } from "./McpRemoteSourceFields";
import { MCP_OAUTH_CONNECTION_SLOT, type McpCredentialInput } from "../sdk/types";
import type { McpStoredSourceSchemaType } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// Remote edit form
// ---------------------------------------------------------------------------

function RemoteEditForm(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "remote" } };
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
  const doUpdate = useAtomSet(updateMcpSource, { mode: "promiseExit" });
  const secretList = useSecretPickerSecrets();
  const credentialEditor = useHttpCredentialEditorController({
    initialCredentials: httpCredentialsFromConfiguredCredentialBindings({
      headers: props.initial.config.headers,
      queryParams: props.initial.config.queryParams,
      bindings: props.bindings,
    }),
    targetScope: credentialTargetScope,
    existingSecrets: secretList,
    sourceName: props.initial.name,
    credentialScopeOptions,
    bindingScopeOptions: credentialScopeOptions,
  });

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [endpoint, setEndpoint] = useState(props.initial.config.endpoint);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();
  const metadataDirty = identityDirty || endpoint.trim() !== props.initial.config.endpoint.trim();
  const dirty = metadataDirty || credentialEditor.state.dirty;
  const oauth2 = props.initial.config.auth.kind === "oauth2" ? props.initial.config.auth : null;
  const oauthConnection = useSourceOAuthConnectionBinding({
    pluginId: "mcp",
    sourceId: props.sourceId,
    sourceScope,
    slotKey: oauth2?.connectionSlot ?? MCP_OAUTH_CONNECTION_SLOT,
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
      headers?: Record<string, McpCredentialInput>;
      queryParams?: Record<string, McpCredentialInput>;
      credentialTargetScope?: ScopeId;
    } = {
      sourceScope,
      name: metadataDirty ? identity.name.trim() || undefined : undefined,
      endpoint: metadataDirty ? endpoint.trim() || undefined : undefined,
    };
    if (credentialEditor.state.dirty) {
      payload.headers = headers;
      payload.queryParams = queryParams as Record<string, McpCredentialInput>;
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

      <HttpCredentialEditor.Provider controller={credentialEditor}>
        <HttpCredentialEditor.Headers />
        <HttpCredentialEditor.QueryParams />
      </HttpCredentialEditor.Provider>

      {oauth2 && (
        <SourceOAuthConnectionControl
          popupName="mcp-oauth"
          pluginId="mcp"
          namespace={slugifyNamespace(props.initial.namespace) || "mcp"}
          fallbackNamespace="mcp"
          endpoint={endpoint.trim()}
          tokenScope={oauthCredentialTargetScope}
          onTokenScopeChange={setOAuthCredentialTargetScope}
          credentialScopeOptions={credentialScopeOptions}
          connectionId={oauthConnection.connectionId}
          sourceLabel={`${identity.name.trim() || props.initial.namespace || "MCP"} OAuth`}
          headers={credentialEditor.serialized.request.headers}
          queryParams={credentialEditor.serialized.request.queryParams}
          isConnected={oauthConnection.isConnected}
          onConnected={oauthConnection.onConnected}
          reconnectingLabel="Reconnecting…"
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
  const sourceResult = useAtomValue(mcpSourceAtom(scopeId, sourceId)) as AsyncResult.AsyncResult<
    McpStoredSourceSchemaType | null,
    unknown
  >;
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : scopeId;
  const bindingsResult = useAtomValue(
    sourceCredentialBindingsAtom(scopeId, "mcp", sourceId, sourceScope),
  );

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
