import { createFileRoute } from "@tanstack/react-router";
import { AgentSetupPage } from "@executor-js/hosted-web/pages/agent-setup";

/** Keep the post-team agent handoff outside the dashboard and available on reload. */
export const Route = createFileRoute("/create_/agent")({
  codeSplitGroupings: [],
  component: AgentSetupPage,
});
