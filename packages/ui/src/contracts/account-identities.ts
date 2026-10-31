/** Group only verified identities already visible in the product's authorized inventory. */
import type { AccountSummary, Inventory } from "./dashboard.ts";

export interface AccountGroup {
  readonly account: AccountSummary;
  readonly bindings: readonly AccountSummary[];
}

export const accountGroups = (accounts: readonly AccountSummary[]): readonly AccountGroup[] => {
  const groups = new Map<string, AccountSummary[]>();
  for (const account of accounts) {
    const key = account.identity?.id ?? account.id;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [account]);
    else group.push(account);
  }
  return [...groups.values()].map((bindings) => {
    const sorted = bindings.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const account = sorted[0]!;
    return { account, bindings: sorted };
  });
};

/** App labels come from the visible inventory, never an identity-wide unfiltered count. */
export const bindingApps = (inventory: Inventory, bindings: readonly AccountSummary[]) => {
  const ids = new Set(bindings.map((account) => account.id));
  return inventory.apps.filter((app) =>
    inventory.links.some((link) => link.app === app.id && ids.has(link.account)),
  );
};
