import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";
import { McpInstallInstructions } from "@executor-js/ui/dashboard/connect";
import { QueryView } from "@executor-js/ui/dashboard/context";
import { ConnectionToolPicker } from "@executor-js/ui/dashboard/connection-tool-picker";
import {
  ScopedConnectionPage,
  ScopedConnectionsPage,
  type ConnectionLinkProps,
  type ConnectTarget,
} from "@executor-js/ui/dashboard/scoped-connections";
import { overviewAtom, toolListAtom } from "../../contracts/api.ts";
import { mcpInstallationAtom } from "../../contracts/mcp.ts";
import {
  mcpConnectionsAtom,
  revokeMcpConnectionAtom,
  saveMcpConnectionAtom,
} from "../../contracts/mcp-connections.ts";
import { Failure, LoadingRows } from "../components/common.tsx";

function ConnectionLink({ connection, className, children }: ConnectionLinkProps) {
  return connection === undefined ? (
    <Link to="/connections" className={className}>
      {children}
    </Link>
  ) : (
    <Link
      to="/connections/$connectionId"
      params={{ connectionId: connection }}
      className={className}
    >
      {children}
    </Link>
  );
}

const renderInstallation = (target: ConnectTarget) =>
  target.apps === undefined ? (
    <McpInstallInstructions endpoint={target.url}>
      Executor keeps running in the background until you stop it. After you restart your computer,
      run <code>executor</code> or <code>executor service start</code> again.
    </McpInstallInstructions>
  ) : (
    <McpInstallInstructions
      endpoint={target.url}
      next="show me which apps and tools this connection can use"
    />
  );

const bindings = {
  query: overviewAtom,
  connections: mcpConnectionsAtom,
  save: saveMcpConnectionAtom,
  revoke: revokeMcpConnectionAtom,
  Failure,
  ConnectionLink,
  renderInstallation,
};

/** This instance's full-access URL and the operator's scoped connections. */
export function ConnectionsPage() {
  return (
    <QueryView query={mcpInstallationAtom} Failure={Failure} pending={<LoadingRows count={4} />}>
      {(installation) => <ScopedConnectionsPage {...bindings} endpoint={installation.endpoint} />}
    </QueryView>
  );
}

/** One scoped connection, or `new` to create one. */
export function ConnectionPage({ connectionId }: { readonly connectionId: string }) {
  const navigate = useNavigate();
  return (
    <ScopedConnectionPage
      {...bindings}
      connectionId={connectionId}
      onCreated={(connection) =>
        void navigate({ to: "/connections/$connectionId", params: { connectionId: connection } })
      }
      onRevoked={() => void navigate({ to: "/connections" })}
      renderConnectAccount={(app) => (
        <Button type="button" variant="ghost" size="sm" className="text-xs" asChild>
          <Link to="/apps/$appId/setup" params={{ appId: app.id }}>
            Connect account
          </Link>
        </Button>
      )}
      renderTools={({ app, names, onChange }) => (
        <ConnectionToolPicker
          query={toolListAtom({ app: app.id, version: app.activeVersion })}
          Failure={Failure}
          names={names}
          onChange={onChange}
        />
      )}
    />
  );
}
