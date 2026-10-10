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
import {
  readOnboardingPracticeProgress,
  writeOnboardingPracticeProgress,
  type OnboardingPracticeStep,
} from "../onboarding-progress";

const ONBOARDING_PRACTICE = [
  {
    key: "build_app",
    title: "Build a Gmail UI",
    description: "Give your agent a concrete interface to build around the inbox.",
    prompt:
      "Using my Gmail integration, build a small inbox triage UI that lets me review, label, and archive emails.",
  },
  {
    key: "create_workflow",
    title: "Add a five-minute cancellation window",
    description: "Use a workflow to leave time to cancel an email before it is sent.",
    prompt:
      "Create a workflow for my Gmail integration that waits five minutes before sending an email and lets me cancel it during that window.",
  },
  {
    key: "create_skill",
    title: "Teach your agent a Gmail skill",
    description: "Save reusable email-handling conventions for future tasks.",
    prompt:
      "Create a reusable Gmail skill. Before sending an email, summarize the recipients, subject, and body, then ask for my approval.",
  },
  {
    key: "store_notes",
    title: "Add notes to emails",
    description: "Store the context your agent should remember about an email thread.",
    prompt:
      "Add notes to my Gmail emails and store the important context from each thread so you can use it in future tasks.",
  },
] as const satisfies readonly {
  readonly key: OnboardingPracticeStep;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}[];

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
  const [agentConnected, setAgentConnected] = useState(false);
  const [elicitationMode, setElicitationMode] = useState<McpElicitationMode>("model");
  const [practiceProgress, setPracticeProgress] = useState<ReadonlySet<OnboardingPracticeStep>>(
    () => readOnboardingPracticeProgress(globalThis.localStorage, organizationSlug),
  );
  const [copiedPracticeStep, setCopiedPracticeStep] = useState<OnboardingPracticeStep | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    setPracticeProgress(readOnboardingPracticeProgress(globalThis.localStorage, organizationSlug));
  }, [organizationSlug]);

  const markPracticeStepComplete = (step: OnboardingPracticeStep) => {
    setPracticeProgress((previous) => {
      if (previous.has(step)) return previous;
      const next = new Set(previous);
      next.add(step);
      writeOnboardingPracticeProgress(globalThis.localStorage, organizationSlug, next);
      trackEvent("onboarding_practice_step_completed", { step });
      return next;
    });
  };
  const activePracticeStep = ONBOARDING_PRACTICE.find((step) => !practiceProgress.has(step.key));

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
            Step 3 of 3
          </p>
          <h1 className="font-sans font-semibold text-3xl">Connect your MCP client</h1>
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

        {!agentConnected ? (
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
                setAgentConnected(true);
              }}
            >
              I&apos;ve connected my agent
            </Button>
          </div>
        ) : (
          <section
            className="flex flex-col gap-4 border-t border-border pt-6"
            aria-label="Try it out"
          >
            <div>
              <h2 className="text-sm font-medium text-foreground">Follow the Gmail example</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Work through one prompt at a time. After you see the result in your agent, confirm
                it here to continue.
              </p>
            </div>
            {activePracticeStep ? (
              <article className="flex flex-col gap-4 rounded-md border border-border p-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Practice step {practiceProgress.size + 1} of {ONBOARDING_PRACTICE.length}
                  </p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {activePracticeStep.title}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {activePracticeStep.description}
                  </p>
                </div>
                <CodeBlock code={activePracticeStep.prompt} lang="text" />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CopyButton
                    value={activePracticeStep.prompt}
                    label="Copy prompt"
                    onCopy={() => {
                      setCopiedPracticeStep(activePracticeStep.key);
                      trackEvent("onboarding_practice_prompt_copied", {
                        step: activePracticeStep.key,
                      });
                    }}
                  />
                  <Button
                    size="sm"
                    disabled={copiedPracticeStep !== activePracticeStep.key}
                    onClick={() => markPracticeStepComplete(activePracticeStep.key)}
                  >
                    I completed this in my agent
                  </Button>
                </div>
              </article>
            ) : (
              <div className="rounded-md border border-border p-4">
                <p className="text-sm font-medium text-foreground">
                  Your Gmail example is complete
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  You can return to the workspace and keep building with your agent.
                </p>
              </div>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void goToApp()}>
                Open workspace
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
