import { QueryView } from "@executor-js/ui/dashboard/context";
import { McpInstallInstructions } from "@executor-js/ui/dashboard/connect";
import { ScopedConnectionsPage } from "@executor-js/ui/dashboard/scoped-connections";
import { ConnectionToolPicker } from "@executor-js/ui/dashboard/connection-tool-picker";
import { overviewAtom, toolListAtom } from "../../contracts/api.ts";
import { mcpInstallationAtom } from "../../contracts/mcp.ts";
import {
  mcpConnectionsAtom,
  revokeMcpConnectionAtom,
  saveMcpConnectionAtom,
} from "../../contracts/mcp-connections.ts";
import { Failure, LoadingRows } from "../components/common.tsx";

/** This instance's full-access URL and the operator's scoped connections. */
export function ConnectAgentPage() {
  return (
    <ScopedConnectionsPage
      query={overviewAtom}
      connections={mcpConnectionsAtom}
      save={saveMcpConnectionAtom}
      revoke={revokeMcpConnectionAtom}
      Failure={Failure}
      renderTools={({ app, names, onChange }) => (
        <ConnectionToolPicker
          query={toolListAtom({
            app: app.id,
            deployment: app.activeDeployment,
          })}
          Failure={Failure}
          names={names}
          onChange={onChange}
        />
      )}
      installation={
        <QueryView
          query={mcpInstallationAtom}
          Failure={Failure}
          pending={<LoadingRows count={3} />}
        >
          {(data) => (
            <McpInstallInstructions endpoint={data.endpoint}>
              Keep the local server running while your agent uses Executor.
            </McpInstallInstructions>
          )}
        </QueryView>
      }
    />
  );
}
