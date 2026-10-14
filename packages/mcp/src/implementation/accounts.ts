/**
 * How agents see an app's linked accounts. Calls never choose them: each call uses the caller's
 * linked accounts, and a tool input that names accounts under `$accounts` is refused.
 */
import { plainAccount, type AccountId, type AppAccounts } from "@executor-js/sdk/core";
import type { McpAccount, McpAppAccounts } from "../contracts/targets.ts";

/** The tool input key agents used to choose accounts with. A call that sets it is refused. */
export const accountsKey = "$accounts";

/** The accounts a requirement uses: every linked account of many(), else the plain one. */
const used = (requirement: McpAppAccounts[string]): readonly McpAccount[] => {
  if (requirement.cardinality === "many") return requirement.accounts;
  const account = plainAccount(requirement.accounts);
  return account === undefined ? [] : [account];
};

/**
 * The caller's accounts discovery lists the catalog and skills with, the same ones a call uses.
 * Undefined when a plain requirement has no linked account. App requirements are left to the host,
 * which fills them from the app links: callers never name them.
 */
export const discoveryAccounts = (linked: McpAppAccounts): AppAccounts | undefined => {
  const accounts: Record<string, ReadonlyArray<AccountId>> = {};
  for (const [slot, requirement] of Object.entries(linked)) {
    const ids = used(requirement).map((account) => account.id);
    if (requirement.cardinality === "one" && ids.length === 0) return undefined;
    accounts[slot] = ids;
  }
  return { app: {}, user: accounts };
};

// Agents read these once per app, so each account stays on one line.
const describe = (account: McpAccount) =>
  `${account.id} (${account.label}${account.description === null ? "" : `: ${account.description.replace(/\s+/g, " ").trim()}`})`;

/**
 * The accounts each user requirement uses, with their ID, label and description. Search lists this
 * once per app. The app's linked accounts are never described.
 */
export const accountSummary = (linked: McpAppAccounts) =>
  Object.entries(linked)
    .flatMap(([slot, requirement]) => {
      const accounts = used(requirement);
      return accounts.length === 0 ? [] : [`${slot}: ${accounts.map(describe).join(" | ")}`];
    })
    .join("; ");
