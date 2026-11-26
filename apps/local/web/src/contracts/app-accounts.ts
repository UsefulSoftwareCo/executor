import { hydrated } from "@executor-js/ui/contracts/http";
import { acknowledge, acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import { Data, Effect } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { withCheckedApps } from "@executor-js/ui/contracts/dashboard";
import type { AccountHealth, AccountId, AccountScope, AppId, VersionId } from "@executor-js/sdk";
import { DashboardClient, overviewAtom } from "./api.ts";
import { refreshAppDiscovery } from "./app-discovery.ts";

const followInventory = <A>(source: Atom.Atom<A>) =>
  Atom.readable(
    (get) => {
      get.subscribe(overviewAtom, () => get.refresh(source));
      return get(source);
    },
    (refresh) => refresh(source),
  );

const appLinks = Atom.family((app: AppId) =>
  DashboardClient.query("dashboard", "appList", hydrated({ params: { app } })).pipe(
    acknowledgedQuery,
  ),
);
const userLinks = Atom.family((app: AppId) =>
  DashboardClient.query("dashboard", "userList", hydrated({ params: { app } })).pipe(
    acknowledgedQuery,
  ),
);
const lists = { app: appLinks, user: userLinks };
export const appLinksAtom = Atom.family((app: AppId) => followInventory(appLinks(app)));
export const userLinksAtom = Atom.family((app: AppId) => followInventory(userLinks(app)));

class RequirementKey extends Data.Class<{
  readonly app: AppId;
  readonly scope: AccountScope;
  readonly requirement: string;
}> {}
const appChoices = Atom.family((key: RequirementKey) =>
  DashboardClient.query(
    "dashboard",
    "appGet",
    hydrated({ params: { app: key.app, requirement: key.requirement } }),
  ).pipe(acknowledgedQuery),
);
const userChoices = Atom.family((key: RequirementKey) =>
  DashboardClient.query(
    "dashboard",
    "userGet",
    hydrated({ params: { app: key.app, requirement: key.requirement } }),
  ).pipe(acknowledgedQuery),
);
const choices = (key: RequirementKey) => (key.scope === "app" ? appChoices(key) : userChoices(key));
const liveChoices = Atom.family((key: RequirementKey) => followInventory(choices(key)));
export const requirementChoicesAtom = (key: ConstructorParameters<typeof RequirementKey>[0]) =>
  liveChoices(new RequirementKey({ app: key.app, scope: key.scope, requirement: key.requirement }));

export const acknowledgeLinkChecks = (
  get: { readonly registry: AtomRegistry.AtomRegistry },
  app: AppId,
  health: AccountHealth,
) => {
  for (const list of [appLinks(app), userLinks(app)])
    acknowledge(get, list, (rows) => rows.map((row) => withCheckedApps(row, health)));
};

export const refreshAppLinks = (
  get: Atom.FnContext | Atom.AtomContext,
  app: AppId,
  requirement?: string,
) => {
  get.registry.refresh(appLinks(app));
  get.registry.refresh(userLinks(app));
  if (requirement !== undefined)
    for (const scope of ["app", "user"] as const)
      get.registry.refresh(choices(new RequirementKey({ app, scope, requirement })));
};

class LinkKey extends Data.Class<{
  readonly app: AppId;
  readonly version: VersionId | null;
  readonly scope: AccountScope;
  readonly requirement: string;
  readonly account: AccountId;
}> {}
type AppAccountLink = Atom.Success<ReturnType<typeof appLinks>>[number];

const linkChanged = (get: Atom.FnContext, key: LinkKey, saved: AppAccountLink | undefined) => {
  const requirement = new RequirementKey({
    app: key.app,
    scope: key.scope,
    requirement: key.requirement,
  });
  acknowledge(get, choices(requirement), (data) => ({
    ...data,
    accounts: data.accounts.map((choice) =>
      choice.account.id === key.account
        ? { ...choice, linked: saved !== undefined }
        : saved !== undefined && data.cardinality === "one"
          ? { ...choice, linked: false }
          : choice,
    ),
  }));
  acknowledge(get, lists[key.scope](key.app), (rows) => {
    const others = rows.filter(
      (row) => row.requirement !== key.requirement || row.account.id !== key.account,
    );
    return saved === undefined ? others : [...others, saved];
  });
  refreshAppDiscovery(get, key);
};
const link = Atom.family((key: LinkKey) =>
  DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) => {
      const params = { app: key.app, requirement: key.requirement, account: key.account };
      return key.scope === "app"
        ? client.dashboard.appLink({ params })
        : client.dashboard.userLink({ params });
    }).pipe(Effect.tap((saved) => Effect.sync(() => linkChanged(get, key, saved)))),
  ),
);
const unlink = Atom.family((key: LinkKey) =>
  DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) => {
      const params = { app: key.app, requirement: key.requirement, account: key.account };
      return key.scope === "app"
        ? client.dashboard.appUnlink({ params })
        : client.dashboard.userUnlink({ params });
    }).pipe(Effect.tap(() => Effect.sync(() => linkChanged(get, key, undefined)))),
  ),
);
export const linkAccountAtom = (key: ConstructorParameters<typeof LinkKey>[0]) =>
  link(new LinkKey(key));
export const unlinkAccountAtom = (key: ConstructorParameters<typeof LinkKey>[0]) =>
  unlink(new LinkKey(key));
