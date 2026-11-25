import type { AccountId, AccountRequirement, App, AppId, ProviderId } from "@executor-js/sdk";

export interface AppAccountLink {
  readonly app: AppId;
  readonly account: AccountId;
}

export interface SharedAppLink {
  readonly app: AppId;
  readonly requirement: string;
  readonly account: AccountId;
  readonly provider: ProviderId;
  readonly label: string;
}

export const linkedAccountIds = (links: readonly AppAccountLink[], app: AppId) =>
  links.flatMap((link) => (link.app === app ? [link.account] : []));

interface LinkedAccount {
  readonly id: AccountId;
  readonly provider: ProviderId;
}

export interface RequirementLink<A> {
  readonly requirement: string;
  readonly account: A;
}

export interface RequirementChoice<A> {
  readonly account: A;
  readonly linked: boolean;
}

export interface RequirementAccounts<A extends LinkedAccount> {
  readonly slot: string;
  readonly requirement: AccountRequirement;
  readonly linked: readonly A[];
  readonly using: readonly A[];
  readonly known: boolean;
}

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

export const missingRequirements = <A extends LinkedAccount>(
  requirements: readonly RequirementAccounts<A>[],
) =>
  requirements.filter(
    (entry) => entry.known && entry.requirement.cardinality === "one" && entry.using.length === 0,
  );

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
