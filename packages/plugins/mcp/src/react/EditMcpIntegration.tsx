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
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { Input } from "@executor-js/react/components/input";
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
import { formatStdioArgs, formatStdioEnv, parseStdioArgs, parseStdioEnv } from "./stdio-fields";

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
// Stdio edit — the command, its arguments, the working directory, and the
// DECLARED static environment. Secret env vars are not edited here: a stdio
// server declares them as a `stdio_env` auth method and their values live on
// the connection, managed from the integration page's accounts hub. Changes
// are staged and applied by the sheet's Save, like the remote editor above.
// ---------------------------------------------------------------------------

type McpStdioConfig = Extract<McpIntegrationConfig, { transport: "stdio" }>;

/** Order-independent identity for a declared env map, so re-ordering the lines
 *  in the field is not reported as a change. */
const envIdentity = (env: Readonly<Record<string, string>> | undefined): string =>
  Object.entries(env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

function StdioEdit(props: {
  server: McpServer & { config: McpStdioConfig };
  onPendingChange?: EditSheetSectionProps["onPendingChange"];
}) {
  const { server } = props;
  const doConfigure = useAtomSet(configureMcpServer, { mode: "promiseExit" });

  const [command, setCommand] = useState(server.config.command);
  const [args, setArgs] = useState(() => formatStdioArgs(server.config.args));
  const [cwd, setCwd] = useState(server.config.cwd ?? "");
  const [env, setEnv] = useState(() => formatStdioEnv(server.config.env));
  const [error, setError] = useState<string | null>(null);

  // The edited config. `configureServer` replaces the whole blob, so anything
  // this form does not surface (`versionNegotiation`, `authenticationTemplate`)
  // is carried through untouched. Empty optional fields are omitted rather than
  // written as `undefined`.
  const edited = useMemo<McpStdioConfig>(() => {
    const { args: _args, cwd: _cwd, env: _env, ...rest } = server.config;
    const nextArgs = parseStdioArgs(args);
    const nextEnv = parseStdioEnv(env);
    const nextCwd = cwd.trim();
    return {
      ...rest,
      command: command.trim(),
      ...(nextArgs.length > 0 ? { args: nextArgs } : {}),
      ...(Object.keys(nextEnv).length > 0 ? { env: nextEnv } : {}),
      ...(nextCwd !== "" ? { cwd: nextCwd } : {}),
    };
  }, [args, command, cwd, env, server.config]);

  const changed =
    edited.command !== server.config.command ||
    formatStdioArgs(edited.args) !== formatStdioArgs(server.config.args) ||
    (edited.cwd ?? "") !== (server.config.cwd ?? "") ||
    envIdentity(edited.env) !== envIdentity(server.config.env);

  // Staged apply, run by the sheet's Save. Persisting the config re-runs
  // discovery on every connection, so the tool catalog matches the new command.
  const applyStaged = useCallback(async (): Promise<EditSheetApplyResult> => {
    setError(null);
    if (edited.command === "") {
      setError("A command is required.");
      return { ok: false };
    }
    const exit = await doConfigure({
      params: { slug: server.slug },
      payload: { config: edited },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError(errorMessageFromExit(exit, "Failed to update the server command"));
      return { ok: false };
    }
    return { ok: true, summary: "Server command updated." };
  }, [doConfigure, edited, server.slug]);

  const onPendingChangeRef = useRef(props.onPendingChange);
  onPendingChangeRef.current = props.onPendingChange;
  useEffect(() => {
    onPendingChangeRef.current?.(changed ? applyStaged : null);
    return () => onPendingChangeRef.current?.(null);
  }, [changed, applyStaged]);

  return (
    <div className="space-y-4 border-t border-border/60 pt-5">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Server command</p>
        <p className="text-xs text-muted-foreground">
          Changes apply when you save. The server's tools are then rediscovered with the new
          command.
        </p>
      </div>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField
            label="Command"
            description="- The executable to run (e.g. npx, uvx, node)."
          >
            <Input
              value={command}
              aria-label="Command"
              onChange={(e) => setCommand((e.target as HTMLInputElement).value)}
              placeholder="npx"
              className="font-mono text-sm"
            />
          </CardStackEntryField>

          <CardStackEntryField
            label="Arguments"
            description="- Space-separated arguments passed to the command."
          >
            <Input
              value={args}
              aria-label="Arguments"
              onChange={(e) => setArgs((e.target as HTMLInputElement).value)}
              placeholder="-y chrome-devtools-mcp@latest"
              className="font-mono text-sm"
            />
          </CardStackEntryField>

          <CardStackEntryField
            label="Working directory"
            description="- Optional. Where the command runs."
          >
            <Input
              value={cwd}
              aria-label="Working directory"
              onChange={(e) => setCwd((e.target as HTMLInputElement).value)}
              placeholder="/path/to/server"
              className="font-mono text-sm"
            />
          </CardStackEntryField>

          <CardStackEntryField
            label="Environment variables"
            description="- One KEY=value per line. The server receives these plus a small base set; it does not inherit executor's environment."
          >
            <Textarea
              value={env}
              aria-label="Environment variables"
              onChange={(e) => setEnv((e.target as HTMLTextAreaElement).value)}
              placeholder={"LOG_LEVEL=debug\nREGION=eu-west-1"}
              className="font-mono text-sm"
            />
          </CardStackEntryField>
        </CardStackContent>
      </CardStack>

      <p className="text-xs text-muted-foreground">
        Secret values do not belong here. A server that needs an API key declares its variable name
        as an authentication method, and the value is entered per connection from the accounts
        panel.
      </p>

      {error && <FormErrorAlert message={error} />}
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
      <StdioEdit
        server={server as McpServer & { config: McpStdioConfig }}
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
