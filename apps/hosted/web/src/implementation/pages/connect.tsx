import { Link } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";
import { Code } from "@executor-js/ui/dashboard/code";
import { McpInstallInstructions } from "@executor-js/ui/dashboard/connect";
import { ScopedConnectionsPage } from "@executor-js/ui/dashboard/scoped-connections";
import { ConnectedAgents } from "@executor-js/ui/dashboard/connected-agents";
import { ConnectionToolPicker } from "@executor-js/ui/dashboard/connection-tool-picker";
import { useOrganizationRoute } from "../components/organization.tsx";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { resourceInventoryAtom } from "../../contracts/resource-access.ts";
import { connectionToolListAtom } from "../../contracts/apps.ts";
import {
  mcpAgentsAtom,
  mcpConnectionsAtom,
  revokeMcpAgentAtom,
  revokeMcpConnectionAtom,
  saveMcpConnectionAtom,
} from "../../contracts/mcp-connections.ts";
import { useDocumentationUrl } from "../documentation.ts";
import { useResourceOrigins } from "../resource-origin.ts";

/** Headless setup: a personal access token against this organization's own addresses. */
function PersonalTokenSetup({
  apiOrigin,
  mcpOrigin,
}: {
  readonly apiOrigin: string;
  readonly mcpOrigin: string;
}) {
  const { organization, slug, id } = useOrganizationRoute();
  const mcp = JSON.stringify(
    {
      mcpServers: {
        executor: {
          type: "http",
          url: `${mcpOrigin}/org/${encodeURIComponent(slug)}/mcp`,
          headers: { Authorization: "Bearer <YOUR_PAT>" },
        },
      },
    },
    null,
    2,
  );
  const http = `curl '${apiOrigin}/api/organizations/${encodeURIComponent(id ?? organization)}/inventory' \\\n  --header 'Authorization: Bearer <YOUR_PAT>'`;
  return (
    <>
      <p className="text-[13px] leading-5 text-muted-foreground">
        For scripts and agents that cannot sign in. The token is yours and has your permissions
        here; this URL names the organization, so no organization header is needed.
      </p>
      <div className="mt-3 overflow-hidden rounded-lg border">
        <Code code={mcp} path="mcp.json" lineNumbers={false} copyable />
      </div>
      <div className="mt-3 overflow-hidden rounded-lg border">
        <Code code={http} path="request.sh" lineNumbers={false} copyable />
      </div>
      <div className="mt-3">
        <Button asChild variant="outline" size="sm">
          <Link to="/account/tokens" search={{ organization: slug }}>
            Manage tokens
          </Link>
        </Button>
      </div>
    </>
  );
}

/** The member's full-access URL, scoped connections and connected agents for this organization. */
export function ConnectPage() {
  const origins = useResourceOrigins();
  const mcpOrigin = origins.mcp[0];
  const { organization } = useOrganizationRoute();
  const docs = useDocumentationUrl();
  return (
    <ScopedConnectionsPage
      key={organization}
      query={resourceInventoryAtom(organization)}
      connections={mcpConnectionsAtom(organization)}
      save={saveMcpConnectionAtom(organization)}
      revoke={revokeMcpConnectionAtom(organization)}
      Failure={HostedFailure}
      docs={docs}
      agents={
        <ConnectedAgents
          query={mcpAgentsAtom(organization)}
          revoke={revokeMcpAgentAtom(organization)}
          Failure={HostedFailure}
        />
      }
      installation={
        <McpInstallInstructions
          endpoint={`${mcpOrigin}/mcp`}
          docs={docs}
          token={<PersonalTokenSetup apiOrigin={origins.api[0]} mcpOrigin={mcpOrigin} />}
        />
      }
      renderTools={({ app, profile, names, onChange }) => (
        <ConnectionToolPicker
          query={connectionToolListAtom({
            organization,
            app: app.id,
            profile: profile?.id,
            expectedProfileRevision: profile?.revision,
            deployment: app.activeDeployment ?? undefined,
          })}
          Failure={HostedFailure}
          names={names}
          onChange={onChange}
        />
      )}
    />
  );
}
