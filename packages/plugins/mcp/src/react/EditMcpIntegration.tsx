import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";

import { IntegrationSlug } from "@executor-js/sdk/shared";
import type { EditSheetApplyResult, EditSheetSectionProps } from "@executor-js/sdk/client";
import { apiKeyMethodLabel, type AuthPlacement } from "@executor-js/sdk/http-auth";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  AuthMethodListEditor,
  useAuthMethodList,
  type AuthMethodRow,
  type AuthMethodSeed,
} from "@executor-js/react/components/auth-method-list-editor";
import { FormErrorAlert } from "@executor-js/react/lib/integration-add";
import { messageFromExit } from "@executor-js/react/api/error-reporting";
import { Button } from "@executor-js/react/components/button";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { Textarea } from "@executor-js/react/components/textarea";

import { configureMcpAuth, mcpServerAtom, updateStdioServer } from "./atoms";
import type {
  McpAuthMethod,
  McpCanonicalAuthMethodInput,
  McpIntegrationConfig,
  McpStdioIntegrationConfig,
} from "../sdk/types";
import {
  editorValueFromMcpAuthMethod,
  mcpAuthMethodInputFromEditorValue,
  mcpWireAuthInput,
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
  if (method.kind === "apikey") return apiKeyMethodLabel(method);
  return "No authentication";
};

const samePlacements = (
  a: readonly AuthPlacement[] | undefined,
  b: readonly AuthPlacement[] | undefined,
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((placement: AuthPlacement, index: number) => {
    const other = right[index];
    return (
      other !== undefined &&
      placement.carrier === other.carrier &&
      placement.name === other.name &&
      (placement.prefix ?? "") === (other.prefix ?? "") &&
      (placement.variable ?? "") === (other.variable ?? "") &&
      (placement.literal ?? null) === (other.literal ?? null)
    );
  });
};

// ---------------------------------------------------------------------------
// Remote edit — v2: the integration's endpoint is part of its identity
// (opaque-to-core config); the editable surface is the declared auth-method
// LIST, through the same shared editor as the add flow. Accounts (credentials)
// are managed from the integration page's accounts hub. Rendered inside the
// integration Edit sheet (plugin `editSheet` slot).
// ---------------------------------------------------------------------------

function RemoteEdit(props: {
  server: McpServer & { config: McpRemoteConfig };
  onPendingChange?: EditSheetSectionProps["onPendingChange"];
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

  const [error, setError] = useState<string | null>(null);

  // The edited methods, slugs preserved for seeded rows so existing
  // connections (bound by template slug) stay attached. New rows omit the
  // slug — the backend assigns kind-based ones.
  const editedMethods = useMemo<readonly McpCanonicalAuthMethodInput[]>(
    () =>
      list.rows.map((row: AuthMethodRow): McpCanonicalAuthMethodInput => {
        const input = mcpAuthMethodInputFromEditorValue(row.value);
        return row.seedSlug !== undefined ? { ...input, slug: row.seedSlug } : input;
      }),
    [list.rows],
  );

  const methodsChanged = useMemo(() => {
    const stored = server.config.authenticationTemplate;
    if (editedMethods.length !== stored.length) return true;
    return editedMethods.some((method: McpCanonicalAuthMethodInput, index: number) => {
      const current = stored[index];
      if (!current) return true;
      if ((method.slug ?? "") !== current.slug) return true;
      if (method.kind !== current.kind) return true;
      if (method.kind === "apikey" && current.kind === "apikey") {
        return !samePlacements(method.placements, current.placements);
      }
      return false;
    });
  }, [editedMethods, server.config.authenticationTemplate]);

  // Staged apply, run by the sheet's Save when the method list changed.
  const applyStaged = useCallback(async (): Promise<EditSheetApplyResult> => {
    setError(null);
    const exit = await doConfigureAuth({
      params: { slug: server.slug },
      payload: {
        authenticationTemplate:
          editedMethods.length > 0
            ? editedMethods.map(mcpWireAuthInput)
            : [{ kind: "none" as const }],
        mode: "replace",
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError("Failed to update authentication methods");
      return { ok: false };
    }
    return { ok: true, summary: "Authentication methods updated." };
  }, [doConfigureAuth, editedMethods, server.slug]);

  const onPendingChangeRef = useRef(props.onPendingChange);
  onPendingChangeRef.current = props.onPendingChange;
  useEffect(() => {
    onPendingChangeRef.current?.(methodsChanged ? applyStaged : null);
    return () => onPendingChangeRef.current?.(null);
  }, [methodsChanged, applyStaged]);

  return (
    <div className="space-y-4 border-t border-border/60 pt-5">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Authentication methods</p>
        <p className="text-xs text-muted-foreground">
          Changes apply when you save. The endpoint (
          <span className="font-mono">{server.config.endpoint}</span>) is part of the server's
          identity — remove and re-add to change it.
        </p>
      </div>

      <AuthMethodListEditor
        list={list}
        oauthMetadata="discovered"
        emptyHint="No methods declared. Add one, or save to mark this server as open (no authentication)."
        footerHint="Connections pick one of these methods. Removing a method detaches connections created against it."
      />

      {error && <FormErrorAlert message={error} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stdio read-only view
// ---------------------------------------------------------------------------

function StdioEditForm(props: {
  server: McpServer & { config: Extract<McpIntegrationConfig, { transport: "stdio" }> };
  onPendingChange?: EditSheetSectionProps["onPendingChange"];
}) {
  const { server } = props;
  const doUpdate = useAtomSet(updateStdioServer, { mode: "promiseExit" });
  const [command, setCommand] = useState(server.config.command || "");
  const [args, setArgs] = useState((server.config.args || []).join(" "));
  const [cwd, setCwd] = useState(server.config.cwd || "");
  const [envVars, setEnvVars] = useState(
    Object.entries(server.config.env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Convert args string back to array
  const argsArray = args.split(" ").filter(Boolean);

  // Parse env vars from textarea
  const envObject = Object.fromEntries(
    envVars
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("="))
      .filter(([k, v]) => k && v),
  );

  const hasChanges =
    command !== server.config.command ||
    argsArray.join(" ") !== (server.config.args || []).join(" ") ||
    cwd !== (server.config.cwd || "") ||
    JSON.stringify(envObject) !== JSON.stringify(server.config.env || {});

  const applyStaged = useCallback(async (): Promise<EditSheetApplyResult> => {
    setError(null);
    setIsSaving(true);
    const config: McpStdioIntegrationConfig = {
      ...server.config,
      command,
      args: argsArray,
      cwd: cwd || undefined,
      env: Object.keys(envObject).length > 0 ? envObject : undefined,
    };
    const exit = await doUpdate({
      params: { slug: server.slug },
      payload: { config },
      reactivityKeys: integrationWriteKeys,
    });
    setIsSaving(false);
    if (Exit.isFailure(exit)) {
      setError(messageFromExit(exit, "Failed to update stdio server"));
      return { ok: false };
    }
    return { ok: true, summary: "Stdio server updated successfully." };
  }, [argsArray, command, cwd, doUpdate, envObject, server.config, server.slug]);

  const onPendingChangeRef = useRef(props.onPendingChange);
  onPendingChangeRef.current = props.onPendingChange;
  useEffect(() => {
    onPendingChangeRef.current?.(hasChanges ? applyStaged : null);
    return () => onPendingChangeRef.current?.(null);
  }, [hasChanges, applyStaged]);

  return (
    <div className="space-y-4 border-t border-border/60 pt-5">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Server configuration</p>
        <p className="text-xs text-muted-foreground">
          Edit the stdio server command and environment variables.
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <Label htmlFor="mcp-stdio-command">Command *</Label>
          <Input
            id="mcp-stdio-command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className="mt-1 w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm"
            placeholder="e.g., node"
            required
          />
        </div>

        <div>
          <Label htmlFor="mcp-stdio-args">Arguments</Label>
          <Input
            id="mcp-stdio-args"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            className="mt-1 w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm"
            placeholder="server.js --port 3000"
          />
          <p className="mt-1 text-xs text-muted-foreground">Space-separated arguments</p>
        </div>

        <div>
          <Label htmlFor="mcp-stdio-cwd">Working Directory</Label>
          <Input
            id="mcp-stdio-cwd"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            className="mt-1 w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm"
            placeholder="/path/to/working/directory"
          />
        </div>

        <div>
          <Label htmlFor="mcp-stdio-env">Environment Variables</Label>
          <Textarea
            id="mcp-stdio-env"
            value={envVars}
            onChange={(e) => setEnvVars(e.target.value)}
            className="mt-1 w-full rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm font-mono"
            placeholder="KEY=value&#10;ANOTHER_KEY=another_value"
            rows={3}
          />
          <p className="mt-1 text-xs text-muted-foreground">One per line, format: KEY=value</p>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400">
          {error}
        </div>
      )}

      {isSaving && <div className="text-sm text-muted-foreground">Saving...</div>}

      <div className="flex gap-2">
        <Button onClick={() => void applyStaged()} disabled={isSaving || !hasChanges}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setCommand(server.config.command || "");
            setArgs((server.config.args || []).join(" "));
            setCwd(server.config.cwd || "");
            setEnvVars(
              Object.entries(server.config.env || {})
                .map(([key, value]) => `${key}=${value}`)
                .join("\n"),
            );
            setError(null);
          }}
          disabled={isSaving}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component — the mcp plugin's section of the integration Edit sheet.
// `integrationId` is the integration slug (v2).
// ---------------------------------------------------------------------------

export default function EditMcpIntegration({
  integrationId,
  onPendingChange,
}: EditSheetSectionProps) {
  const slug = IntegrationSlug.make(integrationId);
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;

  if (!AsyncResult.isSuccess(serverResult) || server === null) return null;

  if (server.config.transport === "stdio") {
    return (
      <StdioEditForm
        server={
          server as McpServer & { config: Extract<McpIntegrationConfig, { transport: "stdio" }> }
        }
        {...(onPendingChange ? { onPendingChange } : {})}
      />
    );
  }

  return (
    <RemoteEdit
      server={server as McpServer & { config: McpRemoteConfig }}
      {...(onPendingChange ? { onPendingChange } : {})}
    />
  );
}
