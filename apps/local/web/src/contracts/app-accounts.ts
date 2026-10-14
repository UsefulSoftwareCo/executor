/**
 * The accounts linked to an app's requirements: app links, for every call and the app's background
 * work, and the local user's links. Locally the owner changes both. Linking, unlinking or
 * connecting an account reads the app's discovery again.
 */
import { hydrated } from "@executor-js/ui/contracts/http";
import { acknowledge, acknowledgedQuery } from "@executor-js/ui/contracts/mutations";
import { Data, Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AccountId, AccountScope, AppId, DeploymentId } from "@executor-js/sdk";
import { DashboardClient, overviewAtom } from "./api.ts";
import { refreshAppDiscovery } from "./app-discovery.ts";

/** Account changes arrive through the live inventory, so each update reads the source again. */
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
/** The accounts linked to the app's own requirements, oldest first per requirement. */
export const appLinksAtom = Atom.family((app: AppId) => followInventory(appLinks(app)));
/** The accounts linked to the app's user requirements, oldest first per requirement. */
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
/** One requirement's linked accounts, then the owner's other accounts of its provider. */
export const requirementChoicesAtom = (key: ConstructorParameters<typeof RequirementKey>[0]) =>
  liveChoices(new RequirementKey({ app: key.app, scope: key.scope, requirement: key.requirement }));

/** Read an app's links again, as after a connection for one of its requirements links an account. */
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
  /** The deployment whose discovery the page shows, read again after the change. */
  readonly deployment: DeploymentId | null;
  readonly scope: AccountScope;
  readonly requirement: string;
  readonly account: AccountId;
}> {}
/** One account linked to one of the app's requirements, with its checks by this app. */
type AppAccountLink = Atom.Success<ReturnType<typeof appLinks>>[number];

/**
 * Publish a confirmed link or unlink to the scope's list and the requirement's choices, which
 * reads both again for a plain requirement's replaced account, then read the app's discovery.
 */
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
/**
 * Link an account to one requirement. For a plain requirement the server replaces the account
 * linked before. Each link is its own mutation, so linking one account cannot cancel another.
 */
export const linkAccountAtom = (key: ConstructorParameters<typeof LinkKey>[0]) =>
  link(new LinkKey(key));
export const unlinkAccountAtom = (key: ConstructorParameters<typeof LinkKey>[0]) =>
  unlink(new LinkKey(key));
