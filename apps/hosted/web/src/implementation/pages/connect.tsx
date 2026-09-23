import {
  ConnectPage as ConnectPageView,
  McpInstallInstructions,
} from "@executor-js/ui/dashboard/connect";

/** Show the hosted MCP endpoint in the shared agent setup flow. */
export function ConnectPage() {
  return (
    <ConnectPageView>
      <McpInstallInstructions endpoint={`${window.location.origin}/mcp`} />
    </ConnectPageView>
  );
}
