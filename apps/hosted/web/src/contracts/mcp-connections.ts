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

export const mcpConnectionsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("mcpConnections", "list", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
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
      get.refresh(resourceInventoryAtom(organization));
      return saved;
    }),
  ),
);
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
      Effect.tap(() => Effect.sync(() => get.refresh(mcpAgentsAtom(organization)))),
    ),
  ),
);

export const mcpAgentsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("mcpConnections", "agents", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
export const AgentBaseline = Schema.Struct({
  organizations: Schema.Array(OrganizationId),
  existing: Schema.Array(GrantId),
});
export type AgentBaseline = typeof AgentBaseline.Type;
export class AgentBaselineRequest extends Data.Class<{
  readonly organizations: ReadonlyArray<OrganizationId>;
  readonly capture: string;
}> {}
export class AgentConnectionAttempt extends Data.Class<AgentBaseline> {}
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
export const newMcpAgentAtom = Atom.family((attempt: AgentConnectionAttempt) =>
  agentIn(
    attempt.organizations.map((organization) =>
      pollingQuery(mcpAgentsAtom(organization), steadyPolling),
    ),
    (agent) => !attempt.existing.includes(agent.id),
  ),
);
export class AgentConfirmation extends Data.Class<{
  readonly organizations: ReadonlyArray<OrganizationId>;
  readonly agent: GrantId;
}> {}
export const confirmedMcpAgentAtom = Atom.family((confirmation: AgentConfirmation) =>
  agentIn(
    confirmation.organizations.map(mcpAgentsAtom),
    (agent) => agent.id === confirmation.agent,
  ),
);
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
            current
              .flat()
              .find(
                (agent) =>
                  agent.access.kind !== "api" && agent.access.kind !== "desktop" && matches(agent),
              ),
          ),
      ),
    (refresh) => {
      for (const atom of lists) refresh(atom);
    },
  );
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
export class ConnectionOwnerRequest extends Data.Class<{
  readonly organizations: ReadonlyArray<OrganizationId>;
  readonly connection: ConnectionId;
}> {}
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
