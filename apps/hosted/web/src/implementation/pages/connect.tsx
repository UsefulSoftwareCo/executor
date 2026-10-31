import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@executor-js/ui/components/button";
import { Code } from "@executor-js/ui/dashboard/code";
import { McpInstallInstructions } from "@executor-js/ui/dashboard/connect";
import {
  ScopedConnectionPage,
  ScopedConnectionsPage,
  type ConnectionLinkProps,
  type ConnectTarget,
} from "@executor-js/ui/dashboard/scoped-connections";
import { ConnectedAgents } from "@executor-js/ui/dashboard/connected-agents";
import { ConnectionToolPicker } from "@executor-js/ui/dashboard/connection-tool-picker";
import { type OrganizationPageReads, useOrganizationRoute } from "../components/organization.tsx";
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

function ConnectionLink({ connection, className, children }: ConnectionLinkProps) {
  const { slug: organizationSlug } = useOrganizationRoute();
  return connection === undefined ? (
    <Link to="/org/$organizationSlug/connect" params={{ organizationSlug }} className={className}>
      {children}
    </Link>
  ) : (
    <Link
      to="/org/$organizationSlug/connect/$connectionId"
      params={{ organizationSlug, connectionId: connection }}
      className={className}
    >
      {children}
    </Link>
  );
}

/** The bindings both connection pages share in this organization. */
function useConnectionBindings() {
  const origins = useResourceOrigins();
  const { organization } = useOrganizationRoute();
  const docs = useDocumentationUrl();
  return {
    query: resourceInventoryAtom(organization),
    connections: mcpConnectionsAtom(organization),
    save: saveMcpConnectionAtom(organization),
    revoke: revokeMcpConnectionAtom(organization),
    Failure: HostedFailure,
    ConnectionLink,
    renderInstallation: (target: ConnectTarget) =>
      target.apps === undefined ? (
        <McpInstallInstructions
          endpoint={target.url}
          docs={docs}
          token={<PersonalTokenSetup apiOrigin={origins.api[0]} mcpOrigin={origins.mcp[0]} />}
        />
      ) : (
        <McpInstallInstructions
          endpoint={target.url}
          docs={docs}
          next="show me which apps and tools this connection can use"
        />
      ),
  };
}

/** Installed apps, MCP connections and connected agents. */
export const connectPageReads: OrganizationPageReads = (organization) => [
  resourceInventoryAtom(organization),
  mcpConnectionsAtom(organization),
  mcpAgentsAtom(organization),
];

/** The member's full-access URL, scoped connections and connected agents for this organization. */
export function ConnectPage() {
  const bindings = useConnectionBindings();
  const { organization } = useOrganizationRoute();
  const origins = useResourceOrigins();
  return (
    <ScopedConnectionsPage
      key={organization}
      {...bindings}
      endpoint={`${origins.mcp[0]}/mcp`}
      agents={
        <ConnectedAgents
          query={mcpAgentsAtom(organization)}
          revoke={revokeMcpAgentAtom(organization)}
          Failure={HostedFailure}
        />
      }
    />
  );
}

/** One of the member's scoped connections, or `new` to create one. */
export function ConnectionPage({ connectionId }: { readonly connectionId: string }) {
  const bindings = useConnectionBindings();
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  return (
    <ScopedConnectionPage
      key={organization}
      {...bindings}
      connectionId={connectionId}
      onCreated={(connection) =>
        void navigate({
          to: "/org/$organizationSlug/connect/$connectionId",
          params: { organizationSlug, connectionId: connection },
        })
      }
      onRevoked={() =>
        void navigate({ to: "/org/$organizationSlug/connect", params: { organizationSlug } })
      }
      renderConnectAccount={(app) => (
        <Button type="button" variant="ghost" size="sm" className="text-xs" asChild>
          <Link
            to="/org/$organizationSlug/apps/$appId"
            params={{ organizationSlug, appId: app.id }}
            search={{ view: "accounts" }}
          >
            Connect account
          </Link>
        </Button>
      )}
      renderTools={({ app, names, onChange }) => (
        <ConnectionToolPicker
          query={connectionToolListAtom({
            organization,
            app: app.id,
            version: app.activeVersion ?? undefined,
          })}
          Failure={HostedFailure}
          names={names}
          onChange={onChange}
        />
      )}
    />
  );
}
