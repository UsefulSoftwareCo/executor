import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { loadedValue } from "@executor-js/dashboard-start/loaded-value";
import { pollingQuery, whileLoaded } from "@executor-js/ui/contracts/polling";
import { Data, Effect } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import type { Account, AccountId, AppId } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { AppAudience, AccessRevision } from "@executor-js/hosted-server/resource-access";
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { providerDisplayUrl } from "@executor-js/ui/contracts/dashboard";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";
import { inventoryAtom } from "./organization.ts";
import { groupsAtom } from "./groups.ts";

class DirectoryKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly view: "available" | "managed";
}> {}
class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
}> {}
const directory = Atom.family((key: DirectoryKey) =>
  HostedClient.query(
    "resourceAccess",
    "directory",
    hydrated({
      params: { organization: key.organization },
      query: { view: key.view },
    }),
  ).pipe(
    revalidated,
    (source) => pollingQuery(source, { active: whileLoaded(({ pendingApp }) => pendingApp) }),
    protectedQuery,
  ),
);
const appAccess = Atom.family((key: AppKey) =>
  HostedClient.query("resourceAccess", "app", hydrated({ params: key })).pipe(
    revalidated,
    protectedQuery,
  ),
);
export const resourceDirectoryAtom = (
  organization: OrganizationReference,
  view: "available" | "managed" = "available",
) => directory(new DirectoryKey({ organization, view }));
export const listedAppAtom = Atom.family((organization: OrganizationReference) =>
  Atom.family((app: AppId) =>
    Atom.readable((get) => {
      const listed = loadedValue(get.registry, resourceDirectoryAtom(organization));
      if (listed === undefined || !AsyncResult.isSuccess(listed)) return undefined;
      const entry = listed.value.apps.find((item) => item.app.id === app);
      return entry === undefined ? undefined : { entry, accounts: listed.value.accounts };
    }),
  ),
);
export const appAccessAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  appAccess(new AppKey(key));
export const refreshResourceDirectory = (
  get: Atom.FnContext,
  organization: OrganizationReference,
) => {
  get.refresh(resourceDirectoryAtom(organization));
  get.refresh(resourceDirectoryAtom(organization, "managed"));
  get.refresh(inventoryAtom(organization));
};
export const acknowledgeResourceAccount = (
  get: Atom.FnContext,
  organization: OrganizationReference,
  account: AccountId,
  saved: Account | undefined,
) => {
  for (const view of ["available", "managed"] as const)
    acknowledge(get, resourceDirectoryAtom(organization, view), (data) => ({
      ...data,
      accounts:
        saved === undefined
          ? data.accounts.filter((entry) => entry.account.id !== account)
          : data.accounts.map((entry) =>
              entry.account.id === account ? { ...entry, account: saved } : entry,
            ),
    }));
  get.refresh(inventoryAtom(organization));
};
const shareApp = Atom.family((key: AppKey) =>
  HostedClient.runtime.fn(
    (payload: { audience: typeof AppAudience.Type; revision: typeof AccessRevision.Type }, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.resourceAccess.shareApp({ params: key, payload }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            acknowledge(get, appAccess(key), () => saved);
            refreshResourceDirectory(get, key.organization);
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            get.refresh(appAccess(key));
            get.refresh(groupsAtom(key.organization));
          }),
        ),
      ),
  ),
);
export const shareAppAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  shareApp(new AppKey(key));

class ListKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly view: "available" | "managed";
  readonly group: string;
}> {}
const inventory = Atom.family((key: ListKey) =>
  Atom.map(
    resourceDirectoryAtom(key.organization, key.view),
    AsyncResult.map((data) => {
      const apps = data.apps
        .filter(
          ({ access }) =>
            key.group === "all" ||
            (key.group === "private"
              ? access.audience.kind === "private"
              : access.audience.kind === "everyone" ||
                (access.audience.kind === "groups" &&
                  access.audience.groups.some((id) => id === key.group))),
        )
        .map(({ app }) => app);
      const listed = data.apps.filter(({ app }) => apps.some((item) => item.id === app.id));
      const links = listed.flatMap(({ app, linkedAccounts }) =>
        linkedAccounts.map((account) => ({ app: app.id, account })),
      );
      const appLinks = listed.flatMap(({ app, appLinks }) =>
        appLinks.map((link) => ({ ...link, app: app.id })),
      );
      const accounts = data.accounts.map(({ account, provider, health }) => ({
        ...account,
        providerName: provider.definition.name,
        providerUrl: providerDisplayUrl(provider.definition),
        ...(health === undefined ? {} : { health }),
      }));
      return {
        apps,
        accounts,
        links,
        appLinks,
        pendingApp: key.group !== "private" && data.pendingApp,
      };
    }),
  ),
);
export const resourceInventoryAtom = (
  organization: OrganizationReference,
  view: "available" | "managed" = "available",
  group = "all",
) => inventory(new ListKey({ organization, view, group }));

export function createAppListAtoms(organization: OrganizationReference) {
  const filters = Atom.make<{
    readonly view: "available" | "managed";
    readonly group: string;
  }>({ view: "available", group: "all" });
  const selected = Atom.readable(
    (get) => {
      const { view, group } = get(filters);
      return get(resourceInventoryAtom(organization, view, group));
    },
    (refresh) => {
      refresh(resourceDirectoryAtom(organization));
      refresh(resourceDirectoryAtom(organization, "managed"));
    },
  );
  return { filters, query: protectedQuery(selected) };
}
