import { CopyButton } from "./code.tsx";

/**
 * Services the product cannot add without guessing are set up by the user's agent, which can read the
 * service's documentation and ask the user how they sign in.
 */
export const agentSetupPrompt = (product: string, endpoint?: string) =>
  [
    `Help me add a service to ${product} as an app. Ask me which service I want to connect.`,
    "",
    "Start with the Executor app's executor skill, then follow its app-authoring skill. Read the service's API and authentication documentation, ask me how I sign in and anything else you need, then write and deploy the app and help me connect my account.",
    ...(endpoint === undefined
      ? []
      : [
          "",
          `If you are not connected to ${product} yet, connect to its MCP server at ${endpoint} first.`,
        ]),
  ].join("\n");

/** A copyable handoff to the user's agent. */
export function AgentSetupPrompt({
  title,
  description,
  prompt,
}: {
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
}) {
  return (
    <section aria-label={title} className="flex max-w-145 flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
      </div>
      <p className="rounded-lg border border-foreground/15 bg-foreground/[0.04] p-4 text-[13px] leading-6 break-words whitespace-pre-line select-text">
        {prompt}
      </p>
      <div>
        <CopyButton
          code={prompt}
          label="Copy setup prompt"
          text="Copy prompt"
          variant="default"
          size="default"
          inline
        />
      </div>
    </section>
  );
}
