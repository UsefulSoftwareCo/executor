import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@executor-js/react/components/button";
import { CodeBlock } from "@executor-js/react/components/code-block";
import { CopyButton } from "@executor-js/react/components/copy-button";

const buildInstallCommand = (endpoint: string): string =>
  `npx add-mcp ${endpoint} --transport http --name executor`;

export const SetupMcpPage = () => {
  const navigate = useNavigate();
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const endpoint = origin ? `${origin}/mcp` : "";
  const command = endpoint ? buildInstallCommand(endpoint) : "";

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
            {endpoint && <CopyButton value={endpoint} />}
          </div>
          <p className="text-xs text-muted-foreground">Paste this into your MCP client config.</p>
        </section>

        <div className="relative flex items-center">
          <div className="h-px flex-1 bg-border" />
          <span className="px-3 text-xs uppercase tracking-wider text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <section aria-label="Install command" className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Install command
          </p>
          <CodeBlock code={command} lang="bash" />
          <p className="text-xs text-muted-foreground">Adds the server to a supported agent.</p>
        </section>

        <div className="flex items-center justify-between gap-3">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            onClick={() => void navigate({ to: "/" })}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip for now
          </button>
          <Button size="sm" onClick={() => void navigate({ to: "/" })}>
            Continue to app
          </Button>
        </div>
      </div>
    </div>
  );
};
