import { useEffect, useState } from "react";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import { CodeBlock } from "./code-block";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { cn } from "../lib/utils";
import { useScopeInfo } from "../api/scope-context";

type TransportMode = "stdio" | "http";

const SUPPORTED_AGENTS = [
  { key: "cursor", label: "Cursor", Icon: CursorIcon },
  { key: "claude", label: "Claude", Icon: ClaudeIcon },
  { key: "opencode", label: "OpenCode", Icon: OpenCodeIcon },
] as const;

const isDev = import.meta.env.DEV;
const isLocal =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname.endsWith(".localhost"));

export const shellQuoteWord = (value: string): string => {
  if (/^[A-Za-z0-9_/:=@%+.,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

interface DesktopBridge {
  readonly getSettings: () => Promise<{
    readonly port: number;
    readonly requireAuth: boolean;
    readonly password: string;
  }>;
}

const readDesktopBridge = (): DesktopBridge | null => {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { readonly executor?: DesktopBridge }).executor;
  if (!candidate || typeof candidate.getSettings !== "function") return null;
  return candidate;
};

const buildHttpEndpoint = (input: {
  readonly origin: string | null;
  readonly desktop: {
    readonly port: number;
  } | null;
}): string => {
  if (input.desktop) {
    return `http://127.0.0.1:${input.desktop.port}/mcp`;
  }
  return input.origin ? `${input.origin}/mcp` : "<this-server>/mcp";
};

const buildBasicAuthHeader = (password: string): string => {
  // Renderer-only — every browser/Electron renderer has btoa. SSR doesn't
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
}): string => {
  if (input.mode === "http") {
    const endpoint = buildHttpEndpoint({
      origin: input.origin,
      desktop: input.desktop ? { port: input.desktop.port } : null,
    });
    const headerFlags: string[] = [];
    if (input.desktop?.requireAuth && input.desktop.password) {
      headerFlags.push(`--header ${shellQuoteWord(buildBasicAuthHeader(input.desktop.password))}`);
    }
    const parts = [
      `npx add-mcp ${shellQuoteWord(endpoint)} --transport http --name executor`,
      ...headerFlags,
    ];
    return parts.join(" ");
  }

  const innerArgs = input.isDev ? ["bun", "run", "dev:cli", "mcp"] : ["executor", "mcp"];
  if (input.scopeDir) {
    innerArgs.push("--scope", input.scopeDir);
  }
  return `npx add-mcp ${shellQuoteWord(innerArgs.map(shellQuoteWord).join(" "))} --name executor`;
};

export function McpInstallCard(props: { className?: string }) {
  const showStdio = isLocal;
  const [mode, setMode] = useState<TransportMode>(showStdio ? "stdio" : "http");
  const [origin, setOrigin] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<{
    readonly port: number;
    readonly requireAuth: boolean;
    readonly password: string;
  } | null>(null);
  const scopeInfo = useScopeInfo();

  useEffect(() => {
    setOrigin(window.location.origin);
    const bridge = readDesktopBridge();
    if (bridge) {
      void bridge.getSettings().then(setDesktop, () => setDesktop(null));
    }
  }, []);

  const command = buildMcpInstallCommand({
    mode,
    isDev,
    origin,
    scopeDir: scopeInfo.dir,
    desktop,
  });

  const subtitle =
    mode === "stdio"
      ? isDev
        ? "Uses the repo-local dev CLI. Run from the repository root."
        : "Requires the executor CLI on your PATH."
      : "Connect to executor as a remote MCP server over streamable HTTP.";

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
