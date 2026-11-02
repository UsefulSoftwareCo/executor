/** Identity checks are private; ordinary account labels and descriptions stay as authored. */
import type { Account, AccountHealth, AccountId } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { accountHolders } from "./contributed-account-policy.ts";
import {
  accountAccesses,
  applicationAccesses,
  currentResourceAuthority,
  policyDatabase,
} from "./resource-policy.ts";

export const redactAccountHealth = (health: AccountHealth): AccountHealth => ({
  ...health,
  info: null,
  infoCheckedAt: null,
});

/** Account holders and account managers may see identity even without editing a linked app. */
export const identityAccounts = (accounts: readonly AccountId[]) =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const holders = yield* accountHolders(yield* policyDatabase, actor.organization, accounts);
    const accesses = yield* accountAccesses(accounts, actor);
    return new Set([
      ...holders.filter((row) => row.holder === actor.user).map((row) => row.account),
      ...accesses.filter((access) => access.canManage).map((access) => access.account),
    ]);
  });

/** Batch the account and app checks for a whole directory or link list. */
const visibleStatuses = (health: readonly AccountHealth[]) =>
  Effect.gen(function* () {
    const visible = yield* identityAccounts(health.map((entry) => entry.account));
    const actor = yield* currentResourceAuthority;
    const editors = new Set(
      (yield* applicationAccesses(
        [...new Set(health.flatMap((entry) => entry.apps.map((app) => app.app)))],
        actor,
      ))
        .filter((access) => access.canManage)
        .map((access) => access.app),
    );
    return health.map((entry) =>
      visible.has(entry.account) || entry.apps.some((app) => editors.has(app.app))
        ? entry
        : redactAccountHealth(entry),
    );
  });

export const visibleAccountHealth = (health: AccountHealth) =>
  visibleStatuses([health]).pipe(Effect.map(([entry]) => entry!));

/** Upstream accounts have human-entered metadata, so only accountInfo needs redaction here. */
export const visibleAccountStatuses = <
  A extends { readonly account: Account; readonly health?: AccountHealth },
>(
  entries: readonly A[],
) =>
  Effect.gen(function* () {
    const health = yield* visibleStatuses(
      entries.flatMap((entry) => (entry.health === undefined ? [] : [entry.health])),
    );
    const byId = new Map(health.map((entry) => [entry.account, entry]));
    return entries.map((entry) =>
      entry.health === undefined ? entry : { ...entry, health: byId.get(entry.account.id)! },
    );
  });
