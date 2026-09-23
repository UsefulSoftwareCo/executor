import { createFileRoute } from "@tanstack/react-router";
import { McpConsentLoading } from "@executor-js/ui/dashboard/mcp-consent";
import { AuthenticationGate } from "../app.tsx";
import { LocalMcpAuthorizePage } from "../pages/mcp-authorize.tsx";
/** OAuth consent uses the local dashboard identity and retains the original signed query. */
export const Route = createFileRoute("/mcp/authorize")({
  component: () => (
    <AuthenticationGate loading={<McpConsentLoading />}>
      <LocalMcpAuthorizePage />
    </AuthenticationGate>
  ),
});
