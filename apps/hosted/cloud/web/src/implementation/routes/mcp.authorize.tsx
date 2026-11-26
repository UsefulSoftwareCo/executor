import { createFileRoute } from "@tanstack/react-router";
import { McpConsentLoading } from "@executor-js/ui/dashboard/mcp-consent";
import { McpAuthorizePage } from "@executor-js/hosted-web/pages/mcp-authorize";

export const Route = createFileRoute("/mcp/authorize")({
  component: McpAuthorizePage,
  pendingComponent: McpConsentLoading,
});
