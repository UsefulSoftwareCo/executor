import { plainAccount, type AccountId, type AppAccounts } from "@executor-js/sdk/core";
import type { McpAccount, McpAppAccounts } from "../contracts/targets.ts";

export const accountsKey = "$accounts";

const used = (requirement: McpAppAccounts[string]): readonly McpAccount[] => {
  if (requirement.cardinality === "many") return requirement.accounts;
  const account = plainAccount(requirement.accounts);
  return account === undefined ? [] : [account];
};

export const discoveryAccounts = (linked: McpAppAccounts): AppAccounts | undefined => {
  const accounts: Record<string, ReadonlyArray<AccountId>> = {};
  for (const [slot, requirement] of Object.entries(linked)) {
    const ids = used(requirement).map((account) => account.id);
    if (requirement.cardinality === "one" && ids.length === 0) return undefined;
    accounts[slot] = ids;
  }
  return { app: {}, user: accounts };
};

const describe = (account: McpAccount) =>
  `${account.id} (${account.label}${account.description === null ? "" : `: ${account.description.replace(/\s+/g, " ").trim()}`})`;

export const accountSummary = (linked: McpAppAccounts) =>
  Object.entries(linked)
    .flatMap(([slot, requirement]) => {
      const accounts = used(requirement);
      return accounts.length === 0 ? [] : [`${slot}: ${accounts.map(describe).join(" | ")}`];
    })
    .join("; ");
