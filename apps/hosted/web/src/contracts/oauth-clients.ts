import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { acknowledge, acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import { Data, Effect, type Redacted } from "effect";
import { Atom } from "effect/reactivity";
import type { HttpUrl, OAuthClientId } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { AppAudience, AccessRevision } from "@executor-js/hosted-server/resource-access";
import { HostedClient } from "./api.ts";
import { groupsAtom } from "./groups.ts";

export const oauthClientsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("oauthClients", "list", hydrated({ params: { organization } })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);

export const registerOAuthClientAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn(
    (
      payload: {
        readonly issuer: typeof HttpUrl.Type;
        readonly clientId: string;
        readonly clientSecret?: Redacted.Redacted<string>;
        readonly audience: typeof AppAudience.Type;
      },
      get,
    ) =>
      Effect.flatMap(HostedClient, (client) =>
        client.oauthClients.register({ params: { organization }, payload }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() =>
            acknowledge(get, oauthClientsAtom(organization), (current) => ({
              ...current,
              clients: [...current.clients, saved],
            })),
          ),
        ),
      ),
  ),
);

class ClientKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly client: OAuthClientId;
}> {}

const removeClient = Atom.family((key: ClientKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.oauthClients.remove({ params: key })).pipe(
      Effect.tap((removed) =>
        Effect.sync(() =>
          acknowledge(get, oauthClientsAtom(key.organization), (current) => ({
            ...current,
            clients: current.clients.filter((entry) => entry.client.id !== removed.client),
          })),
        ),
      ),
    ),
  ),
);
export const removeOAuthClientAtom = (key: {
  organization: OrganizationReference;
  client: OAuthClientId;
}) => removeClient(new ClientKey(key));

const updateClient = Atom.family((key: ClientKey) =>
  HostedClient.runtime.fn(
    (
      payload: {
        readonly clientId?: string;
        readonly clientSecret?: Redacted.Redacted<string>;
        readonly audience: typeof AppAudience.Type;
        readonly revision: typeof AccessRevision.Type;
      },
      get,
    ) =>
      Effect.flatMap(HostedClient, (client) =>
        client.oauthClients.update({ params: key, payload }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() =>
            acknowledge(get, oauthClientsAtom(key.organization), (current) => ({
              ...current,
              clients: current.clients.map((entry) =>
                entry.client.id === saved.client.id ? saved : entry,
              ),
            })),
          ),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            get.refresh(oauthClientsAtom(key.organization));
            get.refresh(groupsAtom(key.organization));
          }),
        ),
      ),
  ),
);
export const updateOAuthClientAtom = (key: {
  organization: OrganizationReference;
  client: OAuthClientId;
}) => updateClient(new ClientKey(key));
