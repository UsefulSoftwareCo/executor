/** The member's own scoped connections and connected agents in one organization, reconciled after each write. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Atom } from "effect/reactivity";
import { Effect } from "effect";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { ConnectionId } from "@executor-js/mcp-auth/connections";
import type { GrantId } from "@executor-js/mcp-auth";
import type { ConnectionSave } from "@executor-js/ui/contracts/scoped-connections";
import { acknowledge, acknowledgedQuery, upsert } from "@executor-js/ui/contracts/mutations";
import { HostedClient } from "./api.ts";
import { resourceInventoryAtom } from "./resource-access.ts";

/** Keep confirmed connections visible while background reconciliation runs. */
export const mcpConnectionsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("mcpConnections", "list", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
/** Create with the editor's chosen ID, or replace an existing connection's name and access. */
export const saveMcpConnectionAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn(({ existing, input }: ConnectionSave, get) =>
    Effect.gen(function* () {
      const client = yield* HostedClient;
      const saved = existing
        ? yield* client.mcpConnections.update({
            params: { organization, connection: input.id },
            payload: { name: input.name, apps: input.apps },
          })
        : yield* client.mcpConnections.create({ params: { organization }, payload: input });
      acknowledge(get, mcpConnectionsAtom(organization), (current) => upsert(current, saved));
      // Saving can create profiles for bare accounts; their labels come from the inventory.
      get.refresh(resourceInventoryAtom(organization));
      return saved;
    }),
  ),
);
/** Remove the row only after the server revoked the connection and its grants. */
export const revokeMcpConnectionAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((connection: ConnectionId, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.mcpConnections.revoke({ params: { organization, connection } }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          acknowledge(get, mcpConnectionsAtom(organization), (current) =>
            current.filter((item) => item.id !== connection),
          ),
        ),
      ),
      // Revoking a connection revokes every agent connected through it.
      Effect.tap(() => Effect.sync(() => get.refresh(mcpAgentsAtom(organization)))),
    ),
  ),
);

/** Agents the member authorized over OAuth in this organization. */
export const mcpAgentsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("mcpConnections", "agents", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
/** Remove the row only after the server revoked the grant and deleted its tokens. */
export const revokeMcpAgentAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((agent: GrantId, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.mcpConnections.revokeAgent({ params: { organization, agent } }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          acknowledge(get, mcpAgentsAtom(organization), (current) =>
            current.filter((item) => item.id !== agent),
          ),
        ),
      ),
    ),
  ),
);
