import { createFileRoute } from "@tanstack/react-router";
import { AgentSetupPage } from "@executor-js/hosted-web/pages/agent-setup";

/** First-run administrator setup hands off to the agent before opening Apps. */
export const Route = createFileRoute("/setup/agent")({
  codeSplitGroupings: [],
  component: AgentSetupPage,
});
