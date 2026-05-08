import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { graphqlSourceAtom, graphqlSourceBindingsAtom, updateGraphqlSource } from "./atoms";
import { useScope } from "@executor-js/react/api/scope-context";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
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
import {
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor-js/react/plugins/source-identity";
import {
  CredentialTargetScopeSelector,
  useCredentialTargetScope,
} from "@executor-js/react/plugins/credential-target-scope";
import { Button } from "@executor-js/react/components/button";
import { FilterTabs } from "@executor-js/react/components/filter-tabs";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";
import { Badge } from "@executor-js/react/components/badge";
import { ScopeId } from "@executor-js/sdk/core";
import {
  GRAPHQL_OAUTH_CONNECTION_SLOT,
  type GraphqlCredentialInput,
  type GraphqlSourceBindingRef,
} from "../sdk/types";
import type { StoredGraphqlSource } from "../sdk/store";

type EditableSource = StoredGraphqlSource;
type AuthMode = "none" | "oauth2";

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

function EditForm(props: {
  sourceId: string;
  initial: EditableSource;
  bindings: readonly GraphqlSourceBindingRef[];
  onSave: () => void;
}) {
  const displayScope = useScope();
  const sourceScope = ScopeId.make(props.initial.scope);
  const { credentialTargetScope, setCredentialTargetScope, credentialScopeOptions } =
    useCredentialTargetScope({
      sourceScope,
      initialTargetScope: initialCredentialTargetScope(sourceScope, props.bindings),
    });
  const doUpdate = useAtomSet(updateGraphqlSource, { mode: "promiseExit" });
  const secretList = useSecretPickerSecrets();

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [endpoint, setEndpoint] = useState(props.initial.endpoint);
  const [credentials, setCredentials] = useState<HttpCredentialsState>(() =>
    httpCredentialsFromConfiguredCredentialBindings({
      headers: props.initial.headers,
      queryParams: props.initial.queryParams,
      bindings: props.bindings,
    }),
  );
  const [authMode, setAuthMode] = useState<AuthMode>(props.initial.auth.kind);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialsDirty, setCredentialsDirty] = useState(false);
  const [authDirty, setAuthDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();
  const metadataDirty = identityDirty || endpoint.trim() !== props.initial.endpoint.trim();
  const dirty = metadataDirty || credentialsDirty || authDirty;

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
      headers?: Record<string, GraphqlCredentialInput>;
      queryParams?: Record<string, GraphqlCredentialInput>;
      credentialTargetScope?: ScopeId;
      auth?: { kind: "none" } | { kind: "oauth2"; connectionSlot: string };
    } = {
      sourceScope,
      name: metadataDirty ? identity.name.trim() || undefined : undefined,
      endpoint: metadataDirty ? endpoint.trim() || undefined : undefined,
    };
    if (credentialsDirty) {
      payload.headers = headers;
      payload.queryParams = queryParams as Record<string, GraphqlCredentialInput>;
      payload.credentialTargetScope = credentialTargetScope;
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

      <SourceIdentityFields identity={identity} namespaceReadOnly />

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField label="Endpoint">
            <Input
              value={endpoint}
              onChange={(e) => {
                setEndpoint((e.target as HTMLInputElement).value);
              }}
              placeholder="https://api.example.com/graphql"
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
        description="Choose where updated GraphQL credentials are saved."
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
    graphqlSourceBindingsAtom(scopeId, props.sourceId, sourceScope),
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
