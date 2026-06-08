import { useCallback, useMemo, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";

import { AuthTemplateSlug, IntegrationSlug } from "@executor-js/sdk/shared";
import { createConnection } from "@executor-js/react/api/atoms";
import { connectionWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { connectionIdentifier } from "@executor-js/react/lib/connection-name";
import {
  CredentialControlField,
  CredentialUsageRow,
  useCredentialTargetScope,
} from "@executor-js/react/plugins/credential-target-scope";
import { OAuthSignInButton } from "@executor-js/react/plugins/oauth-sign-in";
import { Button } from "@executor-js/react/components/button";
import { AddAccountModal } from "@executor-js/react/components/add-account-modal";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";
import { Badge } from "@executor-js/react/components/badge";
import type { AuthMethod } from "@executor-js/react/lib/auth-placements";

import { mcpServerAtom } from "./atoms";
import type { McpIntegrationConfig } from "../sdk/types";

const HEADER_TEMPLATE = AuthTemplateSlug.make("header");
const OAUTH_TEMPLATE = AuthTemplateSlug.make("oauth2");

type McpServer = {
  readonly slug: IntegrationSlug;
  readonly description: string;
  readonly kind: string;
  readonly canRemove: boolean;
  readonly canRefresh: boolean;
  readonly config: McpIntegrationConfig;
};

// ---------------------------------------------------------------------------
// Remote edit — v2: the integration's endpoint + auth template are part of its
// identity (opaque-to-core config). The editable surface is the connection: an
// API-key header value, or an OAuth sign-in, both owner-scoped.
// ---------------------------------------------------------------------------

function RemoteEdit(props: {
  server: McpServer & { config: McpRemoteConfig };
  onSave: () => void;
}) {
  const { server } = props;
  const auth = server.config.auth;
  const { credentialTargetOwner, setCredentialTargetOwner, credentialScopeOptions } =
    useCredentialTargetScope();
  const doCreate = useAtomSet(createConnection, { mode: "promiseExit" });

  const [headerName] = useState(auth.kind === "header" ? auth.headerName : "Authorization");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [oauthModalOpen, setOauthModalOpen] = useState(false);

  const handleSaveKey = useCallback(async () => {
    if (apiKey.trim() === "") return;
    setSaving(true);
    setError(null);
    const exit = await doCreate({
      payload: {
        owner: credentialTargetOwner,
        name: connectionIdentifier(`${server.slug} key`),
        integration: server.slug,
        template: HEADER_TEMPLATE,
        identityLabel: server.description || String(server.slug),
        value: apiKey.trim(),
      },
      reactivityKeys: connectionWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError("Failed to save credential");
      setSaving(false);
      return;
    }
    setSaving(false);
    setConnected(true);
    props.onSave();
  }, [apiKey, credentialTargetOwner, doCreate, server, props]);

  const handleOAuth = useCallback(() => {
    setError(null);
    setOauthModalOpen(true);
  }, []);

  const oauthMethods = useMemo<readonly AuthMethod[]>(
    () =>
      auth.kind === "oauth2"
        ? [
            {
              id: "oauth2",
              label: "OAuth",
              kind: "oauth",
              source: "spec",
              template: OAUTH_TEMPLATE,
              placements: [],
              oauth: { discoveryUrl: server.config.endpoint, supportsDynamicRegistration: true },
            },
          ]
        : [],
    [auth.kind, server.config.endpoint],
  );
  const oauthInitialState = useMemo(
    () =>
      oauthModalOpen && auth.kind === "oauth2"
        ? {
            key: `${String(server.slug)}:${credentialTargetOwner}:oauth`,
            owner: credentialTargetOwner,
            template: String(OAUTH_TEMPLATE),
            label: `${server.description || String(server.slug)} OAuth`,
          }
        : null,
    [auth.kind, credentialTargetOwner, oauthModalOpen, server],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage the connection for this MCP server. The endpoint is part of the server's identity —
          remove and re-add to change it.
        </p>
      </div>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryTitle>{server.description || String(server.slug)}</CardStackEntryTitle>
              <CardStackEntryDescription className="font-mono text-xs">
                {server.config.endpoint}
              </CardStackEntryDescription>
            </CardStackEntryContent>
            <Badge variant="secondary" className="text-xs">
              remote
            </Badge>
          </CardStackEntry>
        </CardStackContent>
      </CardStack>

      {auth.kind === "header" && (
        <CredentialUsageRow
          value={credentialTargetOwner}
          options={credentialScopeOptions}
          onChange={setCredentialTargetOwner}
          label="Connection saved to"
          help="Choose who can use this credential."
        >
          <CredentialControlField label={`${headerName} value`} help="Saved as a connection.">
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey((e.target as HTMLInputElement).value)}
              placeholder="sk-…"
              className="font-mono text-sm"
              autoComplete="new-password"
            />
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSaveKey()}
                disabled={apiKey.trim() === "" || saving}
              >
                {saving ? "Saving…" : connected ? "Saved" : "Save connection"}
              </Button>
            </div>
          </CredentialControlField>
        </CredentialUsageRow>
      )}

      {auth.kind === "oauth2" && (
        <CredentialUsageRow
          value={credentialTargetOwner}
          options={credentialScopeOptions}
          onChange={setCredentialTargetOwner}
          label="Connection saved to"
          help="Choose who can use the OAuth connection."
        >
          <CredentialControlField label="Connect via OAuth" help="Start the provider OAuth flow.">
            <OAuthSignInButton
              busy={false}
              error={error}
              isConnected={connected}
              onSignIn={handleOAuth}
              signingInLabel="Signing in…"
              reconnectingLabel="Reconnecting…"
            />
            <AddAccountModal
              integration={server.slug}
              integrationName={server.description || String(server.slug)}
              methods={oauthMethods}
              open={oauthModalOpen}
              onOpenChange={setOauthModalOpen}
              initialState={oauthInitialState}
            />
          </CredentialControlField>
        </CredentialUsageRow>
      )}

      {auth.kind === "none" && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          This server does not require a credential.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button onClick={props.onSave}>Done</Button>
      </div>
    </div>
  );
}

type McpRemoteConfig = Extract<McpIntegrationConfig, { transport: "remote" }>;

// ---------------------------------------------------------------------------
// Stdio read-only view
// ---------------------------------------------------------------------------

function StdioReadOnly(props: {
  server: McpServer & { config: Extract<McpIntegrationConfig, { transport: "stdio" }> };
  onSave: () => void;
}) {
  const { command, args } = props.server.config;
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
          <p className="truncate text-sm font-semibold text-card-foreground">
            {String(props.server.slug)}
          </p>
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
// Main component — `sourceId` is the integration slug (v2).
// ---------------------------------------------------------------------------

export default function EditMcpSource({
  sourceId,
  onSave,
}: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const slug = IntegrationSlug.make(sourceId);
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;

  if (!AsyncResult.isSuccess(serverResult) || server === null) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  if (server.config.transport === "stdio") {
    return (
      <StdioReadOnly
        server={
          server as McpServer & { config: Extract<McpIntegrationConfig, { transport: "stdio" }> }
        }
        onSave={onSave}
      />
    );
  }

  return <RemoteEdit server={server as McpServer & { config: McpRemoteConfig }} onSave={onSave} />;
}
