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
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { Textarea } from "@executor-js/react/components/textarea";
import { errorMessageFromExit, FormErrorAlert } from "@executor-js/react/lib/integration-add";

import { configureMcpAuth, configureMcpServer, mcpServerAtom } from "./atoms";
import type {
  McpAuthMethod,
  McpCanonicalAuthMethodInput,
  McpIntegrationConfig,
} from "../sdk/types";
import {
  editorValueFromMcpAuthMethod,
  mcpAuthMethodInputFromEditorValue,
  mcpWireAuthInput,
} from "./auth-method-config";
import {
  canonicalizeStdioConfig,
  canonicalizeStdioDraft,
  parseStdioArgs,
  parseStdioEnv,
  sameCanonicalStdioConfig,
  stdioEnvParseErrorMessage,
  stdioEnvToText,
} from "../sdk/stdio-config";

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
// Stdio edit
// ---------------------------------------------------------------------------

function StdioEdit(props: {
  server: McpServer & { config: Extract<McpIntegrationConfig, { transport: "stdio" }> };
  onPendingChange?: EditSheetSectionProps["onPendingChange"];
}) {
  const { server } = props;
  const doConfigure = useAtomSet(configureMcpServer, { mode: "promiseExit" });

  const [commandDraft, setCommandDraft] = useState(server.config.command);
  const [argsDraft, setArgsDraft] = useState((server.config.args ?? []).join(" "));
  const [cwdDraft, setCwdDraft] = useState(server.config.cwd ?? "");
  const [envDraft, setEnvDraft] = useState(stdioEnvToText(server.config.env));
  const [error, setError] = useState<string | null>(null);

  const lastResetSlug = useRef<IntegrationSlug | null>(null);
  useEffect(() => {
    if (lastResetSlug.current === server.slug) return;
    lastResetSlug.current = server.slug;
    setCommandDraft(server.config.command);
    setArgsDraft((server.config.args ?? []).join(" "));
    setCwdDraft(server.config.cwd ?? "");
    setEnvDraft(stdioEnvToText(server.config.env));
    setError(null);
  }, [
    server.config.args,
    server.config.command,
    server.config.cwd,
    server.config.env,
    server.slug,
  ]);

  const stdioDraftChanged = useMemo(
    () =>
      commandDraft !== server.config.command ||
      argsDraft !== (server.config.args ?? []).join(" ") ||
      cwdDraft !== (server.config.cwd ?? "") ||
      envDraft !== stdioEnvToText(server.config.env),
    [argsDraft, commandDraft, cwdDraft, envDraft, server.config],
  );

  const parsedEnvForComparison = useMemo(() => parseStdioEnv(envDraft), [envDraft]);
  const processConfigChanged = useMemo(() => {
    if (!parsedEnvForComparison.ok) return false;
    return !sameCanonicalStdioConfig(
      canonicalizeStdioConfig(server.config),
      canonicalizeStdioDraft({
        command: commandDraft,
        args: parseStdioArgs(argsDraft),
        env: parsedEnvForComparison.env,
        cwd: cwdDraft,
      }),
    );
  }, [argsDraft, commandDraft, cwdDraft, parsedEnvForComparison, server.config]);

  const applyStaged = useCallback(async (): Promise<EditSheetApplyResult> => {
    setError(null);
    const command = commandDraft.trim();
    if (command.length === 0) {
      setError("Command is required.");
      return { ok: false };
    }

    const parsedEnv = parseStdioEnv(envDraft);
    if (!parsedEnv.ok) {
      setError(stdioEnvParseErrorMessage(parsedEnv.error));
      return { ok: false };
    }

    const args = parseStdioArgs(argsDraft);
    const cwd = cwdDraft.trim();
    const nextConfig: Extract<McpIntegrationConfig, { transport: "stdio" }> = {
      transport: "stdio",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(parsedEnv.env !== undefined ? { env: parsedEnv.env } : {}),
      ...(cwd.length > 0 ? { cwd } : {}),
      ...(server.config.authenticationTemplate !== undefined
        ? { authenticationTemplate: server.config.authenticationTemplate }
        : {}),
    };

    if (
      sameCanonicalStdioConfig(
        canonicalizeStdioConfig(server.config),
        canonicalizeStdioConfig(nextConfig),
      )
    ) {
      return { ok: true, summary: null };
    }

    const exit = await doConfigure({
      params: { slug: server.slug },
      payload: { config: nextConfig },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError(errorMessageFromExit(exit, "Failed to update command settings"));
      return { ok: false };
    }
    if (exit.value.toolsRefreshFailed) {
      return {
        ok: true,
        summary:
          "Command settings updated, but tools could not be refreshed. Check secrets or retry.",
      };
    }
    return { ok: true, summary: "Command settings updated." };
  }, [argsDraft, commandDraft, cwdDraft, doConfigure, envDraft, server.config, server.slug]);

  const onPendingChangeRef = useRef(props.onPendingChange);
  onPendingChangeRef.current = props.onPendingChange;
  useEffect(() => {
    onPendingChangeRef.current?.(stdioDraftChanged ? applyStaged : null);
    return () => onPendingChangeRef.current?.(null);
  }, [stdioDraftChanged, applyStaged]);

  return (
    <div className="space-y-4 border-t border-border/60 pt-5">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Command settings</p>
        <p className="text-xs text-muted-foreground">Changes apply when you save.</p>
      </div>

      <div className="space-y-3">
        <Label className="block space-y-1.5">
          <span className="text-xs font-medium text-foreground">Command</span>
          <Input
            value={commandDraft}
            onChange={(e) => setCommandDraft((e.target as HTMLInputElement).value)}
            placeholder="npx"
            className="font-mono text-sm"
          />
        </Label>

        <Label className="block space-y-1.5">
          <span className="text-xs font-medium text-foreground">Arguments</span>
          <Input
            value={argsDraft}
            onChange={(e) => setArgsDraft((e.target as HTMLInputElement).value)}
            placeholder="-y chrome-devtools-mcp@latest"
            className="font-mono text-sm"
          />
        </Label>

        <Label className="block space-y-1.5">
          <span className="text-xs font-medium text-foreground">Working directory</span>
          <Input
            value={cwdDraft}
            onChange={(e) => setCwdDraft((e.target as HTMLInputElement).value)}
            placeholder="/path/to/project"
            className="font-mono text-sm"
            data-ph-block
          />
        </Label>

        <Label className="block space-y-1.5">
          <span className="text-xs font-medium text-foreground">Environment variables</span>
          <Textarea
            value={envDraft}
            onChange={(e) => setEnvDraft((e.target as HTMLTextAreaElement).value)}
            placeholder={"DEBUG=true\nAPI_BASE_URL=https://example.com"}
            className="font-mono text-sm"
            data-ph-block
          />
        </Label>
      </div>

      {processConfigChanged && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Saving these command settings will rediscover tools and reset policies scoped to this
          source.
        </p>
      )}

      {error && <FormErrorAlert message={error} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component — the mcp plugin's section of the integration Edit sheet.
// `sourceId` is the integration slug (v2).
// ---------------------------------------------------------------------------

export default function EditMcpSource({ sourceId, onPendingChange }: EditSheetSectionProps) {
  const slug = IntegrationSlug.make(sourceId);
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;

  if (!AsyncResult.isSuccess(serverResult) || server === null) return null;

  if (server.config.transport === "stdio") {
    return (
      <StdioEdit
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
