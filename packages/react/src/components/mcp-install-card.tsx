import { useState } from "react";
import { trackEvent } from "../api/analytics";
import CursorIcon from "@lobehub/icons/es/Cursor/components/Mono";
import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import OpenCodeIcon from "@lobehub/icons/es/OpenCode/components/Mono";
import { ChevronDown } from "lucide-react";
import { CodeBlock } from "./code-block";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { NativeSelect, NativeSelectOption } from "./native-select";
import { cn } from "../lib/utils";
import { useOrganizationSlug } from "../api/organization-context";
import {
  getExecutorServerAuthorizationHeader,
  useExecutorServerConnection,
} from "../api/server-connection";

export type McpElicitationMode = "browser" | "model" | "native";

const SUPPORTED_AGENTS = [
  { key: "cursor", label: "Cursor", Icon: CursorIcon },
  { key: "claude", label: "Claude", Icon: ClaudeIcon },
  { key: "opencode", label: "OpenCode", Icon: OpenCodeIcon },
] as const;

export const shellQuoteWord = (value: string): string => {
  if (/^[A-Za-z0-9_/:=@%+.,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

export const buildMcpHttpEndpoint = (input: {
  readonly origin: string | null;
  readonly desktop?: {
    readonly port: number;
  } | null;
  readonly elicitationMode?: McpElicitationMode;
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
  if (!input.elicitationMode || input.elicitationMode === "model") return endpoint;

  if (endpoint.startsWith("<")) return `${endpoint}?elicitation_mode=${input.elicitationMode}`;
  const url = new URL(endpoint);
  url.searchParams.set("elicitation_mode", input.elicitationMode);
  return url.toString();
};

export const buildMcpInstallCommand = (input: {
  readonly origin: string | null;
  readonly desktop?: {
    readonly port: number;
  } | null;
  readonly authorizationHeader?: string | null;
  readonly elicitationMode?: McpElicitationMode;
  readonly organizationSlug?: string | null;
}): string => {
  const endpoint = buildMcpHttpEndpoint({
    origin: input.origin,
    desktop: input.desktop ? { port: input.desktop.port } : null,
    elicitationMode: input.elicitationMode,
    organizationSlug: input.organizationSlug,
  });
  const headerFlags: string[] = [];
  if (input.authorizationHeader) {
    headerFlags.push(`--header ${shellQuoteWord(`Authorization: ${input.authorizationHeader}`)}`);
  }
  return [
    `npx add-mcp ${shellQuoteWord(endpoint)} --transport http --name executor`,
    ...headerFlags,
  ].join(" ");
};

export function McpInstallCard(props: { className?: string }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [httpElicitationMode, setHttpElicitationMode] = useState<McpElicitationMode>("model");
  const organizationSlug = useOrganizationSlug();
  const serverConnection = useExecutorServerConnection();

  const authorizationHeader = getExecutorServerAuthorizationHeader(serverConnection);

  const command = buildMcpInstallCommand({
    origin: serverConnection.origin,
    authorizationHeader,
    elicitationMode: httpElicitationMode,
    organizationSlug,
  });

  const subtitle = "Connect to executor as a remote MCP server over streamable HTTP.";

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
              Select how tool approvals are handled for this Remote HTTP connection.
            </div>
          </div>
          <NativeSelect
            size="sm"
            value={httpElicitationMode}
            onChange={(event) => {
              const next = event.target.value as McpElicitationMode;
              setHttpElicitationMode(next);
              trackEvent("mcp_install_elicitation_mode_changed", { elicitation_mode: next });
            }}
            aria-label="Elicitation mode"
            className="min-w-44"
          >
            <NativeSelectOption value="browser">Browser approval</NativeSelectOption>
            <NativeSelectOption value="model">Model resume tool</NativeSelectOption>
            <NativeSelectOption value="native">Native elicitation</NativeSelectOption>
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
      className="items-start py-4"
      rightSlot={<span className="text-xs font-medium text-muted-foreground">Remote HTTP</span>}
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
              transport: "http",
              elicitation_mode: httpElicitationMode,
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
      {header}
      {body}
    </CardStack>
  );
}
