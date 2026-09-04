import { useEffect, useState } from "react";
import { Option, Schema } from "effect";
import { trackEvent } from "../api/analytics";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import { ChevronDown } from "lucide-react";
import { CodeBlock } from "./code-block";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { NativeSelect, NativeSelectOption } from "./native-select";
import { Switch } from "./switch";
import { cn } from "../lib/utils";
import { useOrganizationSlug } from "../api/organization-context";
import {
  getExecutorServerAuthorizationHeader,
  useExecutorServerConnection,
} from "../api/server-connection";

type TransportMode = "stdio" | "http";
export type McpElicitationMode = "browser" | "model" | "native";

const McpInstallPreferencesSchema = Schema.Struct({
  mode: Schema.Literals(["stdio", "http"]),
  httpElicitationMode: Schema.Literals(["browser", "model", "native"]),
  artifacts: Schema.Boolean,
  searchTools: Schema.Boolean,
  // Added after v1 shipped; optional so a stored preference from before it
  // existed still decodes and takes the default (codemode).
  toolMode: Schema.optional(Schema.Literals(["codemode", "passthrough"])),
});

type McpInstallPreferences = typeof McpInstallPreferencesSchema.Type;

const MCP_INSTALL_PREFERENCES_STORAGE_PREFIX = "executor.mcpInstallPreferences.v1";
/** Hosts that are not org-scoped (local, desktop) share this one suffix. */
const UNSCOPED_ORGANIZATION_SUFFIX = "local";

/**
 * Storage key for one organization's install preferences.
 *
 * `localStorage` is per-origin, not per-account, so a single key would carry
 * one org's transport and elicitation choices into every other org — and into
 * every other user — signed in through the same browser. The rendered command
 * differs per org, so a shared preference is wrong rather than merely
 * surprising. Scoping by slug keeps each org's choices to itself; hosts with
 * no org context are a single user by construction and share one bucket.
 */
export const mcpInstallPreferencesStorageKey = (organizationSlug: string | null): string =>
  `${MCP_INSTALL_PREFERENCES_STORAGE_PREFIX}.${organizationSlug ?? UNSCOPED_ORGANIZATION_SUFFIX}`;

const DEFAULT_MCP_INSTALL_PREFERENCES: McpInstallPreferences = {
  mode: "http",
  httpElicitationMode: "model",
  artifacts: true,
  searchTools: false,
  toolMode: "codemode",
};
const decodeMcpInstallPreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(McpInstallPreferencesSchema),
);

const readMcpInstallPreferences = (storageKey: string): McpInstallPreferences => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw when browser storage is disabled
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    return raw
      ? Option.getOrElse(decodeMcpInstallPreferences(raw), () => DEFAULT_MCP_INSTALL_PREFERENCES)
      : DEFAULT_MCP_INSTALL_PREFERENCES;
  } catch {
    return DEFAULT_MCP_INSTALL_PREFERENCES;
  }
};

const writeMcpInstallPreferences = (
  storageKey: string,
  preferences: McpInstallPreferences,
): void => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw when browser storage is disabled
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(preferences));
  } catch {
    // Best-effort persistence; the options still apply to this rendered command.
  }
};

const SUPPORTED_AGENTS = [
  { key: "cursor", label: "Cursor", Icon: CursorIcon },
  { key: "claude", label: "Claude", Icon: ClaudeIcon },
  { key: "opencode", label: "OpenCode", Icon: OpenCodeIcon },
] as const;

const isDev = import.meta.env.DEV;
const devCliCwd = import.meta.env.VITE_EXECUTOR_DEV_CLI_CWD as string | undefined;
const currentLocation = globalThis.window?.location;
const isLocal =
  currentLocation?.hostname === "localhost" ||
  currentLocation?.hostname === "127.0.0.1" ||
  currentLocation?.hostname.endsWith(".localhost") === true;

export const shellQuoteWord = (value: string): string => {
  if (/^[A-Za-z0-9_/:=@%+.,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

const hasDesktopConnectionBridge = (): boolean => {
  return Boolean(globalThis.window?.executor?.getServerConnection);
};

export const buildMcpHttpEndpoint = (input: {
  readonly origin: string | null;
  readonly desktop?: {
    readonly port: number;
  } | null;
  readonly elicitationMode?: McpElicitationMode;
  /** Artifacts are on by default, so only the opt-out is spelled out on the
   *  URL (`&artifacts=false`) and a default endpoint stays clean. */
  readonly artifacts?: boolean;
  /** Per-integration search tools are off by default, so only the opt-in is
   *  spelled out on the URL (`&search_tools=true`). */
  readonly searchTools?: boolean;
  /** Codemode is the default, so only passthrough is spelled out on the URL
   *  (`&mode=passthrough`). */
  readonly toolMode?: "codemode" | "passthrough";
  // Cloud only: pins the URL to `/<org-slug>/mcp` (the server also accepts the
  // legacy `/<org_id>/mcp` form). Desktop/local pass nothing and get the bare
  // `/mcp` path.
  readonly organizationSlug?: string | null;
}): string => {
  // The desktop sidecar isn't org-scoped, so the org only applies to the
  // origin/remote forms.
  const mcpPath =
    input.organizationSlug && !input.desktop ? `/${input.organizationSlug}/mcp` : "/mcp";
  const endpoint = input.desktop
    ? `http://127.0.0.1:${input.desktop.port}${mcpPath}`
    : input.origin
      ? `${input.origin}${mcpPath}`
      : `<this-server>${mcpPath}`;
  // Only non-default choices reach the URL, so the common endpoint has no query
  // at all: `model` elicitation and artifacts-on are what the server assumes.
  const params: Array<readonly [string, string]> = [];
  if (input.elicitationMode && input.elicitationMode !== "model") {
    params.push(["elicitation_mode", input.elicitationMode]);
  }
  if (input.artifacts === false) params.push(["artifacts", "false"]);
  if (input.searchTools === true) params.push(["search_tools", "true"]);
  if (input.toolMode === "passthrough") params.push(["mode", "passthrough"]);
  if (params.length === 0) return endpoint;

  const query = params.map(([key, value]) => `${key}=${value}`).join("&");
  // The `<this-server>` placeholder is not a parsable URL — concatenate.
  if (endpoint.startsWith("<")) return `${endpoint}?${query}`;
  const url = new URL(endpoint);
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
};

export const buildMcpInstallCommand = (input: {
  readonly mode: TransportMode;
  readonly isDev: boolean;
  readonly origin: string | null;
  readonly scopeDir?: string;
  readonly desktop?: {
    readonly port: number;
  } | null;
  readonly authorizationHeader?: string | null;
  readonly elicitationMode?: McpElicitationMode;
  readonly artifacts?: boolean;
  readonly searchTools?: boolean;
  readonly toolMode?: "codemode" | "passthrough";
  readonly devCliCwd?: string;
  readonly organizationSlug?: string | null;
}): string => {
  if (input.mode === "http") {
    const endpoint = buildMcpHttpEndpoint({
      origin: input.origin,
      desktop: input.desktop ? { port: input.desktop.port } : null,
      elicitationMode: input.elicitationMode,
      artifacts: input.artifacts,
      searchTools: input.searchTools,
      toolMode: input.toolMode,
      organizationSlug: input.organizationSlug,
    });
    const headerFlags: string[] = [];
    if (input.authorizationHeader) {
      headerFlags.push(`--header ${shellQuoteWord(`Authorization: ${input.authorizationHeader}`)}`);
    }
    const parts = [
      `npx add-mcp ${shellQuoteWord(endpoint)} --transport http --name executor`,
      ...headerFlags,
    ];
    return parts.join(" ");
  }

  const innerArgs = input.isDev
    ? input.devCliCwd
      ? ["bun", "run", "--cwd", input.devCliCwd, "dev:cli", "mcp"]
      : ["bun", "run", "dev:cli", "mcp"]
    : ["executor", "mcp"];
  if (input.scopeDir) {
    innerArgs.push("--scope", input.scopeDir);
  }
  if (input.elicitationMode && input.elicitationMode !== "model") {
    innerArgs.push("--elicitation-mode", input.elicitationMode);
  }
  if (input.artifacts === false) {
    innerArgs.push("--no-artifacts");
  }
  if (input.searchTools === true) {
    innerArgs.push("--search-tools");
  }
  if (input.toolMode === "passthrough") {
    innerArgs.push("--mode", "passthrough");
  }
  return `npx add-mcp ${shellQuoteWord(innerArgs.map(shellQuoteWord).join(" "))} --name executor`;
};

export function McpInstallCard(props: { className?: string }) {
  const organizationSlug = useOrganizationSlug();
  const serverConnection = useExecutorServerConnection();
  // Desktop hosts ship Electron without putting an `executor` binary on
  // PATH, and the bundled sidecar is locked to the running app. Force the
  // HTTP path there; it routes through the active sidecar connection.
  const showStdio =
    isLocal && serverConnection.kind !== "desktop-sidecar" && !hasDesktopConnectionBridge();
  const storageKey = mcpInstallPreferencesStorageKey(organizationSlug);
  const [preferences, setPreferences] = useState<McpInstallPreferences>(() =>
    readMcpInstallPreferences(storageKey),
  );
  // Switching organizations must load that org's own preferences. Reloading in
  // an effect would let the save effect below run first and write the previous
  // org's choices under the new org's key, which is the bleed this scoping
  // exists to prevent. Adjusting during render re-runs this component before
  // anything commits, so the save effect only ever sees a matched pair.
  const [loadedStorageKey, setLoadedStorageKey] = useState(storageKey);
  if (loadedStorageKey !== storageKey) {
    setLoadedStorageKey(storageKey);
    setPreferences(readMcpInstallPreferences(storageKey));
  }
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { mode, httpElicitationMode, artifacts, searchTools } = preferences;
  const toolMode = preferences.toolMode ?? "codemode";

  useEffect(() => {
    writeMcpInstallPreferences(storageKey, preferences);
  }, [storageKey, preferences]);

  const elicitationMode = mode === "stdio" ? "model" : httpElicitationMode;

  // The desktop renderer's connection carries no auth (the main process injects
  // the bearer at the session layer). For the install command — which an
  // EXTERNAL agent runs and therefore needs the token in plaintext — fetch it
  // on demand from the bridge.
  const [desktopAuthToken, setDesktopAuthToken] = useState<string | null>(null);
  useEffect(() => {
    if (serverConnection.kind !== "desktop-sidecar") {
      setDesktopAuthToken(null);
      return;
    }
    let cancelled = false;
    void globalThis.window?.executor?.getServerAuthToken?.().then(
      (token) => {
        if (!cancelled) setDesktopAuthToken(token);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [serverConnection.kind]);

  const authorizationHeader =
    getExecutorServerAuthorizationHeader(serverConnection) ??
    (desktopAuthToken ? `Bearer ${desktopAuthToken}` : null);

  const command = buildMcpInstallCommand({
    mode,
    isDev,
    origin: serverConnection.origin,
    authorizationHeader,
    elicitationMode,
    artifacts,
    searchTools,
    toolMode,
    devCliCwd,
    organizationSlug,
  });

  const subtitle =
    mode === "stdio"
      ? isDev
        ? "Uses the repo-local dev CLI from any agent working directory."
        : "Requires the executor CLI on your PATH."
      : "Paste this into Claude Code, Cursor, or any MCP client, and your agent gets every tool you connect here.";

  const advancedControls = (
    <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        Advanced
        <ChevronDown
          className={cn("size-3.5 transition-transform", advancedOpen && "rotate-180")}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-muted/25 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">Expose tools directly</div>
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {toolMode === "passthrough"
                ? "Every connected tool is its own MCP tool. Your client handles approvals from each tool's annotations; there is no execute or resume."
                : "Disabled: agents write code against your tools through one execute tool."}
            </div>
          </div>
          <Switch
            checked={toolMode === "passthrough"}
            onCheckedChange={(next) => {
              const nextMode = next ? "passthrough" : "codemode";
              setPreferences((current) => ({ ...current, toolMode: nextMode }));
              trackEvent("mcp_install_tool_mode_changed", { tool_mode: nextMode });
            }}
            aria-label="Expose tools directly"
          />
        </div>
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-muted/25 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">Artifacts</div>
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {artifacts
                ? "Generated UI components are saved to your workspace."
                : "Disabled: this connection serves no artifact tools."}
            </div>
          </div>
          <Switch
            checked={artifacts}
            onCheckedChange={(next) => {
              setPreferences((current) => ({ ...current, artifacts: next }));
              trackEvent("mcp_install_artifacts_toggled", { artifacts: next });
            }}
            aria-label="Artifacts"
          />
        </div>
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-muted/25 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">Integration search tools</div>
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {searchTools
                ? "One search tool per connected integration, so agents see your integrations as tool names."
                : "Disabled: agents discover tools through search inside execute."}
            </div>
          </div>
          <Switch
            checked={searchTools}
            onCheckedChange={(next) => {
              setPreferences((current) => ({ ...current, searchTools: next }));
              trackEvent("mcp_install_search_tools_toggled", { search_tools: next });
            }}
            aria-label="Integration search tools"
          />
        </div>
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-muted/25 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground">Resume approvals</div>
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {mode === "http"
                ? "Select how tool approvals are handled for this Remote HTTP connection."
                : "Standard I/O exposes a resume tool to the model. Use Remote HTTP for browser approvals."}
            </div>
          </div>
          <NativeSelect
            size="sm"
            value={elicitationMode}
            onChange={(event) => {
              const next = event.target.value as McpElicitationMode;
              setPreferences((current) => ({ ...current, httpElicitationMode: next }));
              trackEvent("mcp_install_elicitation_mode_changed", { elicitation_mode: next });
            }}
            aria-label="Elicitation mode"
            className="min-w-44"
          >
            {mode === "http" && (
              <NativeSelectOption value="browser">Browser approval</NativeSelectOption>
            )}
            <NativeSelectOption value="model">Model resume tool</NativeSelectOption>
            {mode === "http" && (
              <NativeSelectOption value="native">Native elicitation</NativeSelectOption>
            )}
          </NativeSelect>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );

  const agentLogos = (
    <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
      <span className="text-xs text-muted-foreground">Work with your agent</span>
      <div className="group/agents flex items-center">
        {SUPPORTED_AGENTS.map(({ key, label, Icon }, index) => (
          <span
            key={key}
            title={label}
            aria-label={label}
            role="img"
            style={{ zIndex: SUPPORTED_AGENTS.length - index }}
            className={cn(
              "flex h-6 items-center justify-center rounded-md border border-border/60 bg-background px-1.5 text-muted-foreground transition-[margin] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
              index > 0 && "-ml-2 group-hover/agents:ml-1",
            )}
          >
            <Icon size={14} />
          </span>
        ))}
      </div>
      <span className="text-xs text-muted-foreground">and more</span>
    </div>
  );

  const header = (
    <CardStackHeader
      className="items-start py-4"
      rightSlot={
        showStdio ? (
          <TabsList>
            <TabsTrigger value="http">Remote HTTP</TabsTrigger>
            <TabsTrigger value="stdio">Standard I/O</TabsTrigger>
          </TabsList>
        ) : undefined
      }
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-semibold text-foreground">Connect an agent</span>
        <span className="text-xs font-normal text-muted-foreground">{subtitle}</span>
      </div>
    </CardStackHeader>
  );

  const body = (
    <CardStackContent>
      <div className="px-4 pt-3 pb-3">
        <CodeBlock
          code={command}
          lang="bash"
          onCopy={() =>
            trackEvent("mcp_install_command_copied", {
              transport: mode,
              elicitation_mode: elicitationMode,
              surface: "integrations",
            })
          }
        />
        {advancedControls && <div className="mt-3">{advancedControls}</div>}
      </div>
      <div className="flex items-center px-4 py-3">{agentLogos}</div>
    </CardStackContent>
  );

  return (
    <CardStack className={props.className}>
      {showStdio ? (
        <Tabs
          value={mode}
          onValueChange={(v) => {
            const next = v as TransportMode;
            setPreferences((current) => ({ ...current, mode: next }));
            trackEvent("mcp_install_transport_switched", { transport: next });
          }}
        >
          {header}
          <TabsContent value="http">{body}</TabsContent>
          <TabsContent value="stdio">{body}</TabsContent>
        </Tabs>
      ) : (
        <>
          {header}
          {body}
        </>
      )}
    </CardStack>
  );
}
