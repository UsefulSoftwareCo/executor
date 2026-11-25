import { hydrated } from "@executor-js/ui/contracts/http";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { withCheckedApps } from "@executor-js/ui/contracts/dashboard";
import { Data, Effect } from "effect";
import { Atom } from "effect/reactivity";
import type {
  AccountHealth,
  AccountId,
  AccountScope,
  App,
  AppId,
  VersionId,
} from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { HostedClient } from "./api.ts";
import { protectedQuery } from "./protected-query.ts";
import { refreshResourceDirectory } from "./resource-access.ts";
import { accountAtom } from "./accounts.ts";
import { refreshAppDiscovery } from "./app-discovery.ts";

class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
}> {}
class RequirementKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly scope: AccountScope;
  readonly requirement: string;
}> {}
class LinkKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version: VersionId | null;
  readonly scope: AccountScope;
  readonly requirement: string;
  readonly account: AccountId;
}> {}

const appLinks = Atom.family((key: AppKey) =>
  HostedClient.query("appAccounts", "appList", hydrated({ params: key })).pipe(
    revalidated,
    protectedQuery,
  ),
);
const userLinks = Atom.family((key: AppKey) =>
  HostedClient.query("appAccounts", "userList", hydrated({ params: key })).pipe(
    revalidated,
    protectedQuery,
  ),
);
const lists = { app: appLinks, user: userLinks };
export type AppAccountLink = Atom.Success<ReturnType<typeof appLinks>>[number];
const liveUserLinks = Atom.family((key: AppKey) => pollingQuery(userLinks(key)));
export const appLinksAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  appLinks(new AppKey(key));
export const userLinksAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  liveUserLinks(new AppKey(key));

const appChoices = Atom.family((key: RequirementKey) =>
  HostedClient.query(
    "appAccounts",
    "appGet",
    hydrated({
      params: { organization: key.organization, app: key.app, requirement: key.requirement },
    }),
  ).pipe(revalidated, protectedQuery),
);
const userChoices = Atom.family((key: RequirementKey) =>
  HostedClient.query(
    "appAccounts",
    "userGet",
    hydrated({
      params: { organization: key.organization, app: key.app, requirement: key.requirement },
    }),
  ).pipe(revalidated, protectedQuery),
);
const choices = (key: RequirementKey) => (key.scope === "app" ? appChoices(key) : userChoices(key));
export const requirementChoicesAtom = (key: ConstructorParameters<typeof RequirementKey>[0]) =>
  choices(
    new RequirementKey({
      organization: key.organization,
      app: key.app,
      scope: key.scope,
      requirement: key.requirement,
    }),
  );

export const refreshAppLinks = (
  get: Atom.FnContext,
  key: {
    readonly organization: OrganizationReference;
    readonly app: AppId;
    readonly requirements?: Readonly<App["requirements"]["accounts"]> | undefined;
  },
) => {
  const app = new AppKey({ organization: key.organization, app: key.app });
  get.refresh(appLinks(app));
  get.refresh(userLinks(app));
  for (const [requirement, { scope }] of Object.entries(key.requirements ?? {}))
    get.refresh(
      choices(
        new RequirementKey({ organization: key.organization, app: key.app, scope, requirement }),
      ),
    );
};

export const acknowledgeLinkChecks = (
  get: Atom.FnContext,
  key: { readonly organization: OrganizationReference; readonly app: AppId },
  health: AccountHealth,
) => {
  const app = new AppKey(key);
  for (const list of [appLinks(app), userLinks(app)])
    acknowledge(get, list, (rows) => rows.map((row) => withCheckedApps(row, health)));
};

const sameLink = (row: AppAccountLink, key: LinkKey) =>
  row.requirement === key.requirement && row.account.id === key.account;

const linkChanged = (get: Atom.FnContext, key: LinkKey, saved: AppAccountLink | undefined) => {
  const app = new AppKey({ organization: key.organization, app: key.app });
  const requirement = new RequirementKey({
    organization: key.organization,
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
  acknowledge(get, lists[key.scope](app), (rows) => {
    const others = rows.filter((row) => !sameLink(row, key));
    return saved === undefined ? others : [...others, saved];
  });
  refreshResourceDirectory(get, key.organization);
  get.refresh(accountAtom({ organization: key.organization, account: key.account }));
  refreshAppDiscovery(get, key);
};

const link = Atom.family((key: LinkKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => {
      const params = {
        organization: key.organization,
        app: key.app,
        requirement: key.requirement,
        account: key.account,
      };
      return key.scope === "app"
        ? client.appAccounts.appLink({ params })
        : client.appAccounts.userLink({ params });
    }).pipe(Effect.tap((saved) => Effect.sync(() => linkChanged(get, key, saved)))),
  ),
);
const unlink = Atom.family((key: LinkKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => {
      const params = {
        organization: key.organization,
        app: key.app,
        requirement: key.requirement,
        account: key.account,
      };
      return key.scope === "app"
        ? client.appAccounts.appUnlink({ params })
        : client.appAccounts.userUnlink({ params });
    }).pipe(Effect.tap(() => Effect.sync(() => linkChanged(get, key, undefined)))),
  ),
);
export const linkAccountAtom = (key: ConstructorParameters<typeof LinkKey>[0]) =>
  link(new LinkKey(key));
export const unlinkAccountAtom = (key: ConstructorParameters<typeof LinkKey>[0]) =>
  unlink(new LinkKey(key));
