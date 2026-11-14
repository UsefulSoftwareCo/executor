/**
 * The accounts linked to an app's requirements: app links, for everyone who uses the app, and the
 * caller's user links. Links are acknowledged before the view changes, and linking, unlinking or
 * connecting reads the app's discovery again.
 */
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
  /** The version whose discovery the page shows, read again after the change. */
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
/** One account linked to one of the app's requirements, with its sign-in and checks. */
export type AppAccountLink = Atom.Success<ReturnType<typeof appLinks>>[number];
/**
 * Open pages reconcile the caller's links changed in another tab or by losing access to an
 * account. App links change only when someone who can edit the app changes them; the page reads
 * them again on its normal refresh and after the caller's own changes, without polling.
 */
const liveUserLinks = Atom.family((key: AppKey) => pollingQuery(userLinks(key)));
/**
 * The accounts linked to the app's own requirements, oldest first per requirement. Anyone who can
 * use the app reads them; only people who can edit it see the identity checks reported.
 */
export const appLinksAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  appLinks(new AppKey(key));
/** The accounts the caller linked to the app's user requirements and can still use. */
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
/**
 * One requirement's linked accounts, then the other accounts of its provider the caller could
 * link. Reading an app requirement needs edit access to the app.
 */
export const requirementChoicesAtom = (key: ConstructorParameters<typeof RequirementKey>[0]) =>
  choices(
    new RequirementKey({
      organization: key.organization,
      app: key.app,
      scope: key.scope,
      requirement: key.requirement,
    }),
  );

/**
 * Read an app's links again, as after a connection for one of its requirements links the account
 * it saves, or an account's credentials change. A new account is also another choice for each of
 * the app's requirements of its provider, so their choices are read again too.
 */
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

/** Show a check's results in the app's links as soon as it finishes, then read them again. */
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

/**
 * Publish a confirmed link or unlink to the scope's list and the requirement's choices, which
 * reads both again for a plain requirement's replaced account, then read what else it changed: the
 * inventory's user links, the account's apps, and the app's discovery.
 */
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
  if (key.scope === "user") refreshResourceDirectory(get, key.organization);
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
/**
 * Link an account to one requirement. For a plain requirement the server replaces the account
 * linked before. Each link is its own mutation, so linking one account cannot cancel another.
 */
export const linkAccountAtom = (key: ConstructorParameters<typeof LinkKey>[0]) =>
  link(new LinkKey(key));
export const unlinkAccountAtom = (key: ConstructorParameters<typeof LinkKey>[0]) =>
  unlink(new LinkKey(key));
