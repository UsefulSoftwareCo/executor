import { useCallback, useMemo, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";

import { IntegrationSlug } from "@executor-js/sdk/shared";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  AuthMethodListEditor,
  useAuthMethodList,
  type AuthMethodRow,
  type AuthMethodSeed,
} from "@executor-js/react/components/auth-method-list-editor";
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
import { FormErrorAlert } from "@executor-js/react/lib/integration-add";

import { configureMcpAuth, mcpServerAtom } from "./atoms";
import type { McpAuthMethod, McpAuthMethodInput, McpIntegrationConfig } from "../sdk/types";
import {
  editorValueFromMcpAuthMethod,
  mcpAuthMethodInputFromEditorValue,
} from "./auth-method-config";

type McpServer = {
  readonly slug: IntegrationSlug;
  readonly description: string;
  readonly kind: string;
  readonly canRemove: boolean;
  readonly canRefresh: boolean;
  readonly config: McpIntegrationConfig;
};

type McpRemoteConfig = Extract<McpIntegrationConfig, { transport: "remote" }>;

const methodSeedLabel = (method: McpAuthMethod): string => {
  if (method.kind === "oauth2") return "OAuth";
  if (method.kind === "header") return `API key (${method.headerName})`;
  return "No authentication";
};

// ---------------------------------------------------------------------------
// Remote edit — v2: the integration's endpoint is part of its identity
// (opaque-to-core config); the editable surface is the declared auth-method
// LIST, through the same shared editor as the add flow. Accounts (credentials)
// are managed from the integration page's accounts hub.
// ---------------------------------------------------------------------------

function RemoteEdit(props: {
  server: McpServer & { config: McpRemoteConfig };
  onSave: () => void;
}) {
  const { server } = props;
  const doConfigureAuth = useAtomSet(configureMcpAuth, { mode: "promiseExit" });

  const seeds = useMemo<readonly AuthMethodSeed[]>(
    () =>
      server.config.authenticationTemplate.map(
        (method: McpAuthMethod): AuthMethodSeed => ({
          value: editorValueFromMcpAuthMethod(method),
          slug: method.slug,
          label: methodSeedLabel(method),
        }),
      ),
    [server.config.authenticationTemplate],
  );
  const list = useAuthMethodList(seeds);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The edited methods, slugs preserved for seeded rows so existing
  // connections (bound by template slug) stay attached. New rows omit the
  // slug — the backend assigns kind-based ones.
  const editedMethods = useMemo<readonly McpAuthMethodInput[]>(
    () =>
      list.rows.map((row: AuthMethodRow): McpAuthMethodInput => {
        const input = mcpAuthMethodInputFromEditorValue(row.value);
        return row.seedSlug !== undefined ? { ...input, slug: row.seedSlug } : input;
      }),
    [list.rows],
  );

  const methodsChanged = useMemo(() => {
    const stored = server.config.authenticationTemplate;
    if (editedMethods.length !== stored.length) return true;
    return editedMethods.some((method: McpAuthMethodInput, index: number) => {
      const current = stored[index];
      if (!current) return true;
      if ((method.slug ?? "") !== current.slug) return true;
      if (method.kind !== current.kind) return true;
      if (method.kind === "header" && current.kind === "header") {
        return (
          method.headerName !== current.headerName ||
          (method.prefix ?? "") !== (current.prefix ?? "")
        );
      }
      return false;
    });
  }, [editedMethods, server.config.authenticationTemplate]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    const exit = await doConfigureAuth({
      params: { slug: server.slug },
      payload: {
        authenticationTemplate:
          editedMethods.length > 0 ? editedMethods : [{ kind: "none" as const }],
        mode: "replace",
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError("Failed to update authentication methods");
      setSaving(false);
      return;
    }
    setSaving(false);
  }, [doConfigureAuth, editedMethods, server.slug]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage how this MCP server authenticates. The endpoint is part of the server's identity —
          remove and re-add to change it. Accounts are added from the integration page.
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

      <AuthMethodListEditor
        list={list}
        title="How does this server authenticate?"
        oauthMetadata="discovered"
        emptyHint="No methods declared. Add one, or save to mark this server as open (no authentication)."
        footerHint="Connections pick one of these methods. Removing a method detaches connections created against it."
      />

      {methodsChanged ? (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save authentication methods"}
          </Button>
        </div>
      ) : null}

      {error && <FormErrorAlert message={error} />}

      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button onClick={props.onSave}>Done</Button>
      </div>
    </div>
  );
}

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
