/** Hosted resolvers bind organization identity here, outside reusable atoms and views. */
import type { RemoteCustomAppInput } from "@executor-js/catalog/contracts";
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { AppId } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { providerDisplayUrl, type InstallApp } from "@executor-js/ui/contracts/dashboard";
import { HostedClient, catalogAtom } from "./api.ts";
import { inventoryAtom } from "./organization.ts";
import { acknowledgeApp, toolsAtom } from "./apps.ts";

/** A separate set of atom identities per organization prevents cross-organization cache reuse. */
export const dashboardAtoms = Atom.family((organization: OrganizationReference) => ({
  inventory: Atom.map(
    inventoryAtom(organization),
    AsyncResult.map((data) => {
      const providers = new Map(
        data.apps.flatMap((app) =>
          Object.values(app.requirements.accounts).map(
            (requirement) => [requirement.provider, requirement.definition] as const,
          ),
        ),
      );
      return {
        ...data,
        accounts: data.accounts.map((account) => {
          const definition = providers.get(account.provider);
          // This API does not expose credential health. Do not invent a successful sign-in state.
          return {
            ...account,
            ...(definition
              ? { providerName: definition.name, providerUrl: providerDisplayUrl(definition) }
              : {}),
          };
        }),
      };
    }),
  ),
  catalog: catalogAtom,
  tools: Atom.family((app: AppId) =>
    Atom.map(
      toolsAtom({ organization, app }),
      AsyncResult.map((page) => page.items),
    ),
  ),
  install: HostedClient.runtime.fn((input: InstallApp, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.apps.install({ params: { organization }, payload: input }),
    ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeApp(get, organization, saved)))),
  ),
  importCustom: HostedClient.runtime.fn((input: RemoteCustomAppInput, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.apps.importCustom({ params: { organization }, payload: { source: input } }),
    ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeApp(get, organization, saved)))),
  ),
}));
