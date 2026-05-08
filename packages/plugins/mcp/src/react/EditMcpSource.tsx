import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import { mcpSourceAtom, mcpSourceBindingsAtom, updateMcpSource } from "./atoms";
import { useScope } from "@executor-js/react/api/scope-context";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor-js/react/plugins/source-identity";
import {
  CredentialTargetScopeSelector,
  useCredentialTargetScope,
} from "@executor-js/react/plugins/credential-target-scope";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  HttpCredentialsEditor,
  serializeScopedHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import {
  httpCredentialsFromConfiguredCredentialBindings,
  initialCredentialTargetScope,
} from "@executor-js/react/plugins/credential-bindings";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";
import { Badge } from "@executor-js/react/components/badge";
import { ScopeId } from "@executor-js/sdk/core";
import type { McpCredentialInput, McpSourceBindingRef } from "../sdk/types";
import type { McpStoredSourceSchemaType } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// Remote edit form
// ---------------------------------------------------------------------------

function RemoteEditForm(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "remote" } };
  bindings: readonly McpSourceBindingRef[];
  onSave: () => void;
}) {
  const displayScope = useScope();
  const sourceScope = ScopeId.make(props.initial.scope);
  const { credentialTargetScope, setCredentialTargetScope, credentialScopeOptions } =
    useCredentialTargetScope({
      sourceScope,
      initialTargetScope: initialCredentialTargetScope(sourceScope, props.bindings),
    });
  const doUpdate = useAtomSet(updateMcpSource, { mode: "promiseExit" });
  const secretList = useSecretPickerSecrets();

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [endpoint, setEndpoint] = useState(props.initial.config.endpoint);
  const [credentials, setCredentials] = useState<HttpCredentialsState>(() =>
    httpCredentialsFromConfiguredCredentialBindings({
      headers: props.initial.config.headers,
      queryParams: props.initial.config.queryParams,
      bindings: props.bindings,
    }),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialsDirty, setCredentialsDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();
  const metadataDirty = identityDirty || endpoint.trim() !== props.initial.config.endpoint.trim();
  const dirty = metadataDirty || credentialsDirty;

  const handleCredentialsChange = (next: HttpCredentialsState) => {
    setCredentials(next);
    setCredentialsDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const { headers, queryParams } = serializeScopedHttpCredentials(
      credentials,
      credentialTargetScope,
    );
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
    if (credentialsDirty) {
      payload.headers = headers;
      payload.queryParams = queryParams as Record<string, McpCredentialInput>;
      payload.credentialTargetScope = credentialTargetScope;
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
    setCredentialsDirty(false);
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

      <SourceIdentityFields identity={identity} namespaceReadOnly />

      {/* Endpoint */}
      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Endpoint">
            <Input
              value={endpoint}
              onChange={(e) => {
                setEndpoint((e.target as HTMLInputElement).value);
              }}
              placeholder="https://mcp.example.com"
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <CredentialTargetScopeSelector
        value={credentialTargetScope}
        options={credentialScopeOptions}
        onChange={(targetScope) => {
          setCredentialTargetScope(targetScope);
          setCredentialsDirty(true);
        }}
        description="Choose where updated MCP credentials are saved."
      />

      <HttpCredentialsEditor
        credentials={credentials}
        onChange={handleCredentialsChange}
        existingSecrets={secretList}
        sourceName={identity.name}
        targetScope={credentialTargetScope}
        credentialScopeOptions={credentialScopeOptions}
        bindingScopeOptions={credentialScopeOptions}
      />

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
          Stdio MCP sources cannot be edited in the UI. Modify the executor.jsonc config file
          directly.
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
  const bindingsResult = useAtomValue(mcpSourceBindingsAtom(scopeId, sourceId, sourceScope));

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
