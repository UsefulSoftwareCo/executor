import { QueryView } from "@executor-js/ui/dashboard/context";
import { ConnectPage, McpInstallInstructions } from "@executor-js/ui/dashboard/connect";
import { mcpInstallationAtom } from "../../contracts/mcp.ts";
import { Failure, LoadingRows } from "../components/common.tsx";

/** Load this local instance's OAuth endpoint into the shared MCP setup page. */
export function ConnectAgentPage() {
  return (
    <ConnectPage>
      <QueryView query={mcpInstallationAtom} Failure={Failure} pending={<LoadingRows count={3} />}>
        {(data) => (
          <McpInstallInstructions endpoint={data.endpoint}>
            Connect and choose which apps and tools your agent can use. Keep the local server
            running.
          </McpInstallInstructions>
        )}
      </QueryView>
    </ConnectPage>
  );
}
