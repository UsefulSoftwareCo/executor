import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CopyButton } from "@executor-js/ui/dashboard/code";
import { SessionMenu } from "../components/auth.tsx";
import { documentationUrl } from "../../contracts/documentation.ts";

/** Shared onboarding layout keeps identity controls outside the main instructions. */
export function SetupPageFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 pt-6 pb-24">
      {children}
      <footer className="fixed bottom-[max(16px,_env(safe-area-inset-bottom))] left-[max(12px,_env(safe-area-inset-left))] w-[200px] max-w-[calc(100%-88px)] bg-background">
        <SessionMenu />
      </footer>
    </main>
  );
}

/** A reloadable handoff keeps the MCP URL and first prompt available after team creation. */
export function AgentSetupPage() {
  const endpoint = `${window.location.origin}/mcp`;
  const docsUrl = new URL(documentationUrl(), window.location.origin).href;
  const prompt = `Help me connect to Executor over MCP at ${endpoint}.\n\nRead the docs to understand the product at ${docsUrl}, then help me get my first app set up.`;
  return (
    <SetupPageFrame>
      <section className="w-full max-w-[560px]" aria-labelledby="agent-setup-title">
        <div className="mb-8 flex items-center gap-2 font-mono text-[15px]">
          <img src="/favicon.png" alt="" className="size-5" />
          <span>executor</span>
        </div>
        <h1 id="agent-setup-title" className="text-3xl font-medium tracking-[-0.04em]">
          Continue in your agent
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          You use Executor through your AI agent. Connect it over MCP, then ask it to build apps,
          use your tools, or extend what you already have.
        </p>
        <div className="mt-8">
          <h2 className="text-sm font-medium">Your MCP URL</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Add this URL in your agent's MCP settings.
          </p>
          <div className="mt-3 flex items-center gap-2 rounded-lg border bg-muted/30 p-2 pl-4">
            <code className="min-w-0 flex-1 break-all text-[13px]">{endpoint}</code>
            <CopyButton code={endpoint} label="Copy MCP URL" text="" size="icon-sm" inline />
          </div>
        </div>
        <div className="mt-8 border-t pt-6">
          <h2 className="text-sm font-medium">Send this to your agent</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Start a conversation with this prompt.
          </p>
          <p className="mt-4 rounded-lg border border-foreground/15 bg-foreground/[0.08] p-4 text-sm leading-6 break-words whitespace-pre-line">
            {prompt}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <CopyButton
              code={prompt}
              label="Copy starter prompt"
              text="Copy prompt"
              variant="default"
              size="default"
              inline
            />
            <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
              Open dashboard &rarr;
            </Link>
          </div>
        </div>
      </section>
    </SetupPageFrame>
  );
}
