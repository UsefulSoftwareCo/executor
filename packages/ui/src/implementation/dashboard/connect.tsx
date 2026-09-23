import { PageFrame, PageHeader } from "./page.tsx";
import { useAtomSet } from "@effect/atom-react";
import { Exit, Option, Redacted, Schema } from "effect";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon, ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { useState, type ReactNode } from "react";
import { copyMcpInstallAtom, McpInstallFormat } from "../../contracts/mcp.ts";
import { mcpInstallCode } from "../lib/mcp-install.ts";
import { Code, CopyButton } from "./code.tsx";
import { Button } from "../components/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.tsx";

const starterPrompt = "Use Executor to show me what apps I can use and help me get started.";

/** Shared Connect page shell; each product owns its data loading and authentication. */
export function ConnectPage({ children }: { readonly children: ReactNode }) {
  return (
    <PageFrame>
      <div className="max-w-190">
        <PageHeader
          title="Connect an agent"
          description="Connect over MCP to use and extend your Executor apps from your agent."
        />
        <section aria-label="MCP installation" className="mt-8">
          {children}
        </section>
        <section aria-labelledby="agent-prompt-title" className="mt-8 border-t pt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="agent-prompt-title" className="text-sm font-medium">
              Then, ask your agent
            </h2>
            <CopyButton
              code={starterPrompt}
              label="Copy starter prompt"
              text="Copy prompt"
              size="sm"
              inline
            />
          </div>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            Once connected, send a message like this:
          </p>
          <blockquote className="mt-4 border-l-2 border-input py-1 pl-4 text-sm leading-6 select-text">
            {starterPrompt}
          </blockquote>
        </section>
      </div>
    </PageFrame>
  );
}

/** Client setup with an optional bearer credential and product-specific help text. */
export function McpInstallInstructions({
  endpoint,
  apiKey,
  children,
}: {
  readonly endpoint: string;
  readonly apiKey?: Redacted.Redacted<string>;
  readonly children?: ReactNode;
}) {
  const [format, setFormat] = useState<McpInstallFormat>("installer");
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = useAtomSet(copyMcpInstallAtom, { mode: "promiseExit" });
  const code = mcpInstallCode(
    format,
    endpoint,
    apiKey === undefined ? undefined : showKey ? Redacted.value(apiKey) : "••••••••",
  );
  return (
    <div className="mcp-install-content min-w-0">
      <Tabs
        value={format}
        onValueChange={(value) => {
          const parsed = Schema.decodeUnknownOption(McpInstallFormat)(value);
          if (Option.isSome(parsed)) {
            setFormat(parsed.value);
            setCopied(false);
            setCopyFailed(false);
          }
        }}
      >
        <TabsList
          aria-label="Installation method"
          variant="line"
          className="h-11! w-full justify-start gap-6 border-b p-0 [&_[data-slot='tabs-trigger']]:h-full [&_[data-slot='tabs-trigger']]:flex-none [&_[data-slot='tabs-trigger']]:rounded-none [&_[data-slot='tabs-trigger']]:px-0 [&_[data-slot='tabs-trigger']]:text-[13px] [&_[data-slot='tabs-trigger']]:after:bottom-0"
        >
          <TabsTrigger
            data-product-area="connect"
            data-product-action="select_installer"
            value="installer"
          >
            Quick install
          </TabsTrigger>
          <TabsTrigger
            data-product-area="connect"
            data-product-action="select_claude"
            value="claude"
          >
            Claude Code
          </TabsTrigger>
          <TabsTrigger data-product-area="connect" data-product-action="select_json" value="json">
            Manual config
          </TabsTrigger>
        </TabsList>
        {(["installer", "claude", "json"] as const).map((method) => (
          <TabsContent key={method} value={method}>
            <p className="mcp-install-step mt-4 mb-3 text-[13px] leading-5 text-muted-foreground">
              {method === "installer"
                ? "Run in your terminal, then choose your agent."
                : method === "claude"
                  ? "Run in your terminal to add Executor to Claude Code for all projects."
                  : "Merge this entry into your client’s MCP configuration."}
            </p>
            <div className="mcp-install-code min-w-0 overflow-hidden rounded-lg border">
              <div className="relative [&_pre]:py-5! [&_pre]:pr-14! [&_pre]:pl-5! [&_pre]:leading-6!">
                <Button
                  data-product-area="connect"
                  data-product-action={`copy_${method}`}
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-3 right-2 text-muted-foreground hover:text-foreground"
                  aria-label={method === "json" ? "Copy config" : "Copy command"}
                  title={copied ? "Copied" : method === "json" ? "Copy config" : "Copy command"}
                  aria-live="polite"
                  onClick={() => {
                    setCopyFailed(false);
                    void copy(
                      Redacted.make(
                        mcpInstallCode(
                          format,
                          endpoint,
                          apiKey === undefined ? undefined : Redacted.value(apiKey),
                        ),
                      ),
                    ).then((exit) => {
                      setCopied(Exit.isSuccess(exit));
                      setCopyFailed(Exit.isFailure(exit));
                    });
                  }}
                >
                  {copied ? (
                    <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-hidden size={14} />
                  ) : (
                    <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden size={14} />
                  )}
                  <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
                </Button>
                <Code code={code} path={method === "json" ? "mcp.json" : "install.sh"} />
              </div>
              {apiKey !== undefined && (
                <div className="mcp-code-footer flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
                  <span>Copy includes your API key.</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowKey(!showKey)}
                    aria-pressed={showKey}
                  >
                    {showKey ? (
                      <HugeiconsIcon
                        icon={ViewOffSlashIcon}
                        strokeWidth={2}
                        aria-hidden
                        size={14}
                      />
                    ) : (
                      <HugeiconsIcon icon={ViewIcon} strokeWidth={2} aria-hidden size={14} />
                    )}
                    {showKey ? "Hide key" : "Show key"}
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>
      {copyFailed && (
        <p className="mcp-copy-error mt-3.5 text-destructive text-[13px]" role="alert">
          {apiKey === undefined
            ? "Could not copy. Select and copy the text instead."
            : "Could not copy. Show the key, then select and copy the text."}
        </p>
      )}
      {children && (
        <p className="field-hint mt-4 text-xs leading-5 text-muted-foreground">{children}</p>
      )}
    </div>
  );
}
