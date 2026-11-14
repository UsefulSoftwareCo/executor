import { CopyButton } from "./code.tsx";

/** Hands a custom app's description to the user's agent, which writes and deploys it. */
export const newAppPrompt = (description: string, endpoint?: string) =>
  [
    "Help me build a new Executor app.",
    "",
    description.trim() === ""
      ? "Ask me what the app should do."
      : `What it should do: ${description.trim()}`,
    "",
    "Start with the Executor app's executor skill, then follow its app-authoring skill. Ask me anything you need, including which accounts it uses, then write and deploy the app and help me connect my accounts.",
    ...(endpoint === undefined
      ? []
      : [
          "",
          `If you are not connected to Executor yet, connect to its MCP server at ${endpoint} first.`,
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
