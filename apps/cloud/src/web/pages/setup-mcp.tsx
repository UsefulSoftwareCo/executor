import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { trackEvent } from "@executor-js/react/api/analytics";
import { Button } from "@executor-js/react/components/button";
import { CodeBlock } from "@executor-js/react/components/code-block";
import {
  buildMcpHttpEndpoint,
  buildMcpInstallCommand,
  type McpElicitationMode,
} from "@executor-js/react/components/mcp-install-card";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor-js/react/components/collapsible";
import { NativeSelect, NativeSelectOption } from "@executor-js/react/components/native-select";

import { useAuth } from "../auth";

export const SetupMcpPage = () => {
  const navigate = useNavigate();
  const auth = useAuth();
  const organizationSlug =
    auth.status === "authenticated" ? (auth.organization?.slug ?? null) : null;
  // Land DIRECTLY on the org's canonical URL. Navigating to the bare
  // `/{-$orgSlug}` would mount the shell at `/`, then OrgSlugGate would fire a
  // SECOND navigation to canonicalize `/` → `/<slug>` — that double hop is the
  // window where the shell paints over this still-mounted onboarding page.
  const goToApp = () =>
    navigate({ to: "/{-$orgSlug}", params: { orgSlug: organizationSlug ?? undefined } });
  const [origin, setOrigin] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [elicitationMode, setElicitationMode] = useState<McpElicitationMode>("model");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const endpoint = origin
    ? buildMcpHttpEndpoint({
        origin,
        desktop: null,
        elicitationMode,
        organizationSlug,
      })
    : "";
  const command = origin
    ? buildMcpInstallCommand({
        mode: "http",
        isDev: false,
        origin,
        elicitationMode,
        organizationSlug,
      })
    : "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Step 2 of 2
          </p>
          <h1 className="font-serif text-3xl">Connect your MCP client</h1>
          <p className="text-sm text-muted-foreground">
            Executor exposes your sources, secrets, and tools to any MCP-compatible agent. Copy the
            URL into your client, or run the install command.
          </p>
        </header>

        <section aria-label="MCP server URL" className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            MCP server URL
          </p>
          <div className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground/90">
              {endpoint || "…"}
            </span>
            {endpoint && (
              <CopyButton
                value={endpoint}
                onCopy={() =>
                  trackEvent("mcp_install_command_copied", {
                    transport: "http",
                    elicitation_mode: elicitationMode,
                    surface: "setup_mcp",
                  })
                }
              />
            )}
          </div>
          <p className="text-xs text-muted-foreground">Paste this into your MCP client config.</p>
        </section>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            Advanced
            <span
              aria-hidden="true"
              className={`text-[10px] transition-transform ${advancedOpen ? "rotate-180" : ""}`}
            >
              v
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-card/60 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">Resume approvals</div>
                <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  Select how tool approvals are handled for this MCP connection.
                </div>
              </div>
              <NativeSelect
                size="sm"
                value={elicitationMode}
                onChange={(event) => setElicitationMode(event.target.value as McpElicitationMode)}
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

        <div className="relative flex items-center">
          <div className="h-px flex-1 bg-border" />
          <span className="px-3 text-xs uppercase tracking-wider text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <section aria-label="Install command" className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Install command
          </p>
          <CodeBlock
            code={command}
            lang="bash"
            onCopy={() =>
              trackEvent("mcp_install_command_copied", {
                transport: "http",
                elicitation_mode: elicitationMode,
                surface: "setup_mcp",
              })
            }
          />
          <p className="text-xs text-muted-foreground">Adds the server to a supported agent.</p>
        </section>

        <div className="flex items-center justify-between gap-3">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            onClick={() => {
              trackEvent("setup_mcp_skipped");
              void goToApp();
            }}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip for now
          </button>
          <Button
            size="sm"
            onClick={() => {
              trackEvent("setup_mcp_completed");
              void goToApp();
            }}
          >
            Continue to app
          </Button>
        </div>
      </div>
    </div>
  );
};
