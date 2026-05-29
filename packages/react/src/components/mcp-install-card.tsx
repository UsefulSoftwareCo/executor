import { useState } from "react";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import { ChevronDown } from "lucide-react";
import { CodeBlock } from "./code-block";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { NativeSelect, NativeSelectOption } from "./native-select";
import { cn } from "../lib/utils";
import { useScopeInfo } from "../api/scope-context";
import {
  getExecutorServerAuthorizationHeader,
  useExecutorServerConnection,
} from "../api/server-connection";

type TransportMode = "stdio" | "http";
export type McpElicitationMode = "browser" | "model" | "native";

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
}): string => {
  const endpoint = input.desktop
    ? `http://127.0.0.1:${input.desktop.port}/mcp`
    : input.origin
      ? `${input.origin}/mcp`
      : "<this-server>/mcp";
  if (!input.elicitationMode || input.elicitationMode === "model") return endpoint;

  if (endpoint.startsWith("<")) return `${endpoint}?elicitation_mode=${input.elicitationMode}`;
  const url = new URL(endpoint);
  url.searchParams.set("elicitation_mode", input.elicitationMode);
  return url.toString();
};

const buildBasicAuthHeader = (password: string): string => {
  // Renderer-only: every browser/Electron renderer has btoa. SSR doesn't
  // render this card, so we don't need a Node fallback here.
  if (typeof globalThis.btoa !== "function") {
    return `Authorization: Basic executor:${password}`;
  }
  return `Authorization: Basic ${globalThis.btoa(`executor:${password}`)}`;
};

export const buildMcpInstallCommand = (input: {
  readonly mode: TransportMode;
  readonly isDev: boolean;
  readonly origin: string | null;
  readonly scopeDir?: string;
  readonly desktop?: {
    readonly port: number;
    readonly requireAuth: boolean;
    readonly password: string;
  } | null;
  readonly authorizationHeader?: string | null;
  readonly elicitationMode?: McpElicitationMode;
  readonly devCliCwd?: string;
}): string => {
  if (input.mode === "http") {
    const endpoint = buildMcpHttpEndpoint({
      origin: input.origin,
      desktop: input.desktop ? { port: input.desktop.port } : null,
      elicitationMode: input.elicitationMode,
    });
    const headerFlags: string[] = [];
    if (input.authorizationHeader) {
      headerFlags.push(`--header ${shellQuoteWord(`Authorization: ${input.authorizationHeader}`)}`);
    } else if (input.desktop?.requireAuth && input.desktop.password) {
      headerFlags.push(`--header ${shellQuoteWord(buildBasicAuthHeader(input.desktop.password))}`);
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
  return `npx add-mcp ${shellQuoteWord(innerArgs.map(shellQuoteWord).join(" "))} --name executor`;
};

export function McpInstallCard(props: { className?: string }) {
  const [mode, setMode] = useState<TransportMode>("http");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [httpElicitationMode, setHttpElicitationMode] = useState<McpElicitationMode>("model");
  const scopeInfo = useScopeInfo();
  const serverConnection = useExecutorServerConnection();
  // Desktop hosts ship Electron without putting an `executor` binary on
  // PATH, and the bundled sidecar is locked to the running app. Force the
  // HTTP path there; it routes through the active sidecar connection.
  const showStdio =
    isLocal && serverConnection.kind !== "desktop-sidecar" && !hasDesktopConnectionBridge();

  const elicitationMode = mode === "stdio" ? "model" : httpElicitationMode;
  const authorizationHeader = getExecutorServerAuthorizationHeader(serverConnection);

  const command = buildMcpInstallCommand({
    mode,
    isDev,
    origin: serverConnection.origin,
    scopeDir: scopeInfo.dir,
    authorizationHeader,
    elicitationMode,
    devCliCwd,
  });

  const subtitle =
    mode === "stdio"
      ? isDev
        ? "Uses the repo-local dev CLI from any agent working directory."
        : "Requires the executor CLI on your PATH."
      : "Connect to executor as a remote MCP server over streamable HTTP.";

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
            onChange={(event) => setHttpElicitationMode(event.target.value as McpElicitationMode)}
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
            style={{ zIndex: SUPPORTED_AGENTS.length - index }}
            className={cn(
              "flex h-6 items-center justify-center rounded-md border border-border/60 bg-background px-1.5 transition-[margin] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
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
      className="items-start pt-3 pb-1"
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
      <div className="px-4 pt-1 pb-3">
        <CodeBlock code={command} lang="bash" />
        {advancedControls && <div className="mt-3">{advancedControls}</div>}
      </div>
      <div className="flex items-center px-4 py-3">{agentLogos}</div>
    </CardStackContent>
  );

  return (
    <CardStack className={props.className}>
      {showStdio ? (
        <Tabs value={mode} onValueChange={(v) => setMode(v as TransportMode)}>
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
