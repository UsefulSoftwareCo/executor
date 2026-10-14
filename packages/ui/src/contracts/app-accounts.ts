/**
 * Accounts linked to an app, shared by dashboards. Calls never choose accounts: an app uses its app
 * links for its app requirements and the caller's user links for its user requirements, the one
 * linked account of a plain requirement and every one of a many() requirement.
 */
import type { AccountId, AccountRequirement, App, AppId, ProviderId } from "@executor-js/sdk";

/** An account the caller linked to an app, as the inventory lists it. */
export interface AppAccountLink {
  readonly app: AppId;
  readonly account: AccountId;
}

/** The ids of the accounts linked to one app, in link order. */
export const linkedAccountIds = (links: readonly AppAccountLink[], app: AppId) =>
  links.flatMap((link) => (link.app === app ? [link.account] : []));

interface LinkedAccount {
  readonly id: AccountId;
  readonly provider: ProviderId;
}

/** An account linked to one of the app's requirements, in either scope. */
export interface RequirementLink<A> {
  readonly requirement: string;
  readonly account: A;
}

/** One account a requirement lists: linked to it, or one the caller could link. */
export interface RequirementChoice<A> {
  readonly account: A;
  readonly linked: boolean;
}

/**
 * One requirement with its linked accounts, oldest first, and the ones the app runs with: the one
 * of a plain requirement, or every one of a many() requirement. A plain requirement with none is
 * missing. `known` is false when the host has not read the requirement's links, such as the apps
 * list, whose inventory names no requirements.
 */
export interface RequirementAccounts<A extends LinkedAccount> {
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly linked: readonly A[];
  readonly using: readonly A[];
  readonly known: boolean;
}

/**
 * Each requirement of the app with its linked accounts: app requirements with the app links, user
 * requirements with the caller's user links. A scope whose links are not given is unknown.
 */
export const requirementAccounts = <A extends LinkedAccount>(
  app: App,
  links: {
    readonly app?: readonly RequirementLink<A>[] | undefined;
    readonly user?: readonly RequirementLink<A>[] | undefined;
  },
): readonly RequirementAccounts<A>[] =>
  Object.entries(app.requirements.accounts).map(([slot, requirement]) => {
    const scoped = links[requirement.scope];
    const linked = (scoped ?? []).flatMap((link) =>
      link.requirement === slot ? [link.account] : [],
    );
    const newest = linked.at(-1);
    return {
      slot,
      requirement,
      linked,
      using: requirement.cardinality === "many" ? linked : newest === undefined ? [] : [newest],
      known: scoped !== undefined,
    };
  });

/** Plain requirements known to have no account; the app cannot run until each has one. */
export const missingRequirements = <A extends LinkedAccount>(
  requirements: readonly RequirementAccounts<A>[],
) =>
  requirements.filter(
    (entry) => entry.known && entry.requirement.cardinality === "one" && entry.using.length === 0,
  );

/**
 * The accounts the app runs with, each once, or undefined while a plain requirement has none.
 * Unknown requirements add none.
 */
export const usedAccounts = <A extends LinkedAccount>(
  requirements: readonly RequirementAccounts<A>[],
): readonly A[] | undefined => {
  if (missingRequirements(requirements).length > 0) return undefined;
  const used: A[] = [];
  for (const entry of requirements)
    for (const account of entry.using)
      if (!used.some((item) => item.id === account.id)) used.push(account);
  return used;
};
