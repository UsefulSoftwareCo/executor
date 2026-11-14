/** The member's own scoped connections and connected agents in one organization, reconciled after each write. */
import { browserOnly, hydrated, hydratedResult } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { pollingQuery, steadyPolling } from "@executor-js/ui/contracts/polling";
import { AsyncResult, Atom } from "effect/reactivity";
import { Data, Effect, Option, Schema } from "effect";
import {
  OrganizationId,
  type OrganizationReference,
} from "@executor-js/hosted-server/organization";
import type { ConnectedAgent } from "@executor-js/mcp-auth/agents";
import type { ConnectionId } from "@executor-js/mcp-auth/connections";
import { GrantId } from "@executor-js/mcp-auth/grants";
import type {
  ConnectionSave,
  ConsentConnection,
} from "@executor-js/ui/contracts/scoped-connections";
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
      // Saving can link accounts to apps; their labels come from the inventory.
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
/**
 * The agents that already held a grant when a guide's baseline was read, in each of the member's
 * organizations. An agent the member authorizes by following the guide is never among them.
 */
export const AgentBaseline = Schema.Struct({
  organizations: Schema.Array(OrganizationId),
  existing: Schema.Array(GrantId),
});
export type AgentBaseline = typeof AgentBaseline.Type;
/**
 * One read of the agents already connected. `capture` names the read, so each one is made again
 * rather than cached: a guide opened directly reads its own while the server renders it, and the
 * assistants read one before any guide is chosen.
 */
export class AgentBaselineRequest extends Data.Class<{
  readonly organizations: ReadonlyArray<OrganizationId>;
  readonly capture: string;
}> {}
/** One attempt to connect a new agent, compared with its baseline. */
export class AgentConnectionAttempt extends Data.Class<AgentBaseline> {}
/**
 * Reads the baseline once per request, never replaced by an empty list. A read made while the
 * server renders a guide reaches the browser with the page.
 */
export const agentBaselineAtom = Atom.family((request: AgentBaselineRequest) =>
  HostedClient.runtime
    .atom(
      Effect.flatMap(HostedClient, (client) =>
        Effect.forEach(
          request.organizations,
          (organization) => client.mcpConnections.agents({ params: { organization } }),
          { concurrency: "unbounded" },
        ),
      ).pipe(
        Effect.map((lists): AgentBaseline => ({
          organizations: request.organizations,
          existing: lists.flat().map((agent) => agent.id),
        })),
      ),
    )
    .pipe(
      hydratedResult({
        key: `hosted:agent-baseline:${request.capture}:${request.organizations.join(",")}`,
        success: AgentBaseline,
      }),
    ),
);
/**
 * The first assistant that connected over MCP since the attempt's baseline, in any of the
 * member's organizations. Agents are listed only once a grant holds a usable token, so a
 * registered client that never completed sign-in does not count, and an Executor HTTP API grant
 * is not an assistant connection. Every authorization creates a new grant, so reconnecting an
 * assistant that was already connected counts. Retrying reads only the current lists; the
 * attempt's baseline stays fixed. Reads every 5 seconds while the page is visible and stops when
 * unmounted.
 */
export const newMcpAgentAtom = Atom.family((attempt: AgentConnectionAttempt) =>
  agentIn(
    attempt.organizations.map((organization) =>
      pollingQuery(mcpAgentsAtom(organization), steadyPolling),
    ),
    (agent) => !attempt.existing.includes(agent.id),
  ),
);
/** An agent named by a link to the first prompt, in any of the member's organizations. */
export class AgentConfirmation extends Data.Class<{
  readonly organizations: ReadonlyArray<OrganizationId>;
  readonly agent: GrantId;
}> {}
/**
 * The confirmation's agent while the member holds a usable MCP grant for it. Reads the current
 * lists; a revoked agent, an API client or another member's grant is not found.
 */
export const confirmedMcpAgentAtom = Atom.family((confirmation: AgentConfirmation) =>
  agentIn(
    confirmation.organizations.map(mcpAgentsAtom),
    (agent) => agent.id === confirmation.agent,
  ),
);
/** The first assistant connected over MCP, not through the Executor HTTP API, that `matches`. */
const agentIn = (
  lists: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<ConnectedAgent>, unknown>>>,
  matches: (agent: ConnectedAgent) => boolean,
) =>
  Atom.readable(
    (get) =>
      AsyncResult.map(
        AsyncResult.all(lists.map((atom) => get(atom))),
        (current): Option.Option<ConnectedAgent> =>
          Option.fromNullishOr(
            current.flat().find((agent) => agent.access.kind !== "api" && matches(agent)),
          ),
      ),
    (refresh) => {
      for (const atom of lists) refresh(atom);
    },
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

/**
 * The member's connections in one organization as the sign-in page lists them, each with the
 * names of the apps it reaches. Both reads refresh when the tab becomes visible again, so a
 * connection created in another tab appears on return. The page needs only the names from the
 * organization's app directory, so the browser reads it rather than the server sending the whole
 * directory with the document.
 */
export const consentConnectionsAtom = Atom.family((organization: OrganizationId) =>
  browserOnly(
    Atom.readable(
      (get) =>
        AsyncResult.map(
          AsyncResult.all([
            get(mcpConnectionsAtom(organization)),
            get(resourceInventoryAtom(organization)),
          ]),
          ([connections, inventory]): readonly ConsentConnection[] => {
            const names = new Map(inventory.apps.map((app) => [app.id, app.name]));
            return connections.map((connection) => ({
              id: connection.id,
              name: connection.name,
              apps: connection.policy.apps.map((item) => names.get(item.app) ?? "Unavailable app"),
            }));
          },
        ),
      (refresh) => {
        refresh(mcpConnectionsAtom(organization));
        refresh(resourceInventoryAtom(organization));
      },
    ),
  ),
);
/** Which of the member's organizations holds a connection a sign-in URL names. */
export class ConnectionOwnerRequest extends Data.Class<{
  readonly organizations: ReadonlyArray<OrganizationId>;
  readonly connection: ConnectionId;
}> {}
/**
 * The organization holding the named connection, or none when no listed organization does, such
 * as after it was revoked. Reads each organization's list, which the page shows next anyway; in
 * the browser, as the page's list is.
 */
export const connectionOwnerAtom = Atom.family((request: ConnectionOwnerRequest) =>
  browserOnly(
    Atom.readable(
      (get) =>
        AsyncResult.map(
          AsyncResult.all(
            request.organizations.map((organization) =>
              AsyncResult.map(get(mcpConnectionsAtom(organization)), (connections) =>
                connections.some((item) => item.id === request.connection)
                  ? Option.some(organization)
                  : Option.none<OrganizationId>(),
              ),
            ),
          ),
          (found) => Option.firstSomeOf(found),
        ),
      (refresh) => {
        for (const organization of request.organizations) refresh(mcpConnectionsAtom(organization));
      },
    ),
  ),
);
