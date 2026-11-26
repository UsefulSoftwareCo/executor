import { createFileRoute } from "@tanstack/react-router";
import { McpConsentLoading } from "@executor-js/ui/dashboard/mcp-consent";
import { AuthenticationGate } from "../app.tsx";
import { LocalMcpAuthorizePage } from "../pages/mcp-authorize.tsx";
export const Route = createFileRoute("/mcp/authorize")({
  component: () => (
    <AuthenticationGate loading={<McpConsentLoading rows={2} />}>
      <LocalMcpAuthorizePage />
    </AuthenticationGate>
  ),
});
