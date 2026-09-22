import { refreshResourceDirectory } from "./resource-access.ts";
import { protectedQuery } from "./protected-query.ts";
/** Account queries remain independent across organizations, including OAuth returns. */
import type { Account, AccountId, App } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { Data, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { acknowledge, upsert, invalidate } from "@executor-js/ui/contracts/mutations";
import { HostedClient } from "./api.ts";
import { inventoryAtom } from "./organization.ts";
import { appAtom, toolsAtom } from "./apps.ts";

class AccountKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly account: AccountId;
}> {}
const accountQuery = Atom.family((key: AccountKey) =>
  HostedClient.query("accounts", "get", { params: key }).pipe(
    Atom.refreshOnWindowFocus,
    protectedQuery,
  ),
);
export const accountAtom = (key: {
  readonly organization: OrganizationReference;
  readonly account: AccountId;
}) => accountQuery(new AccountKey(key));
const renameAccount = Atom.family((key: AccountKey) =>
  HostedClient.runtime.fn((label: string, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.accounts.rename({ params: key, payload: { label } }),
    ).pipe(
      Effect.tap((saved) => Effect.sync(() => acknowledgeAccount(get, key.organization, saved))),
    ),
  ),
);
/** A different account cannot supersede this account's rename request. */
export const renameAccountAtom = (key: {
  organization: OrganizationReference;
  account: AccountId;
}) => renameAccount(new AccountKey(key));
export const reconnectAccountAtom = HostedClient.mutation("accounts", "reconnect");
const disconnectAccount = Atom.family((key: AccountKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.accounts.disconnect({ params: key })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          refreshResourceDirectory(get, key.organization);
          refreshCredentialDependents(get, key.organization, key.account);
          const previous = AsyncResult.value(get(inventoryAtom(key.organization)));
          if (Option.isSome(previous))
            for (const app of previous.value.apps) {
              acknowledge(
                get,
                appAtom({ organization: key.organization, app: app.id }),
                (current) => withoutAccount(current, key.account),
              );
            }
          acknowledge(get, inventoryAtom(key.organization), (data) => ({
            ...data,
            accounts: data.accounts.filter((account) => account.id !== key.account),
            apps: data.apps.map((app) => withoutAccount(app, key.account)),
          }));
          invalidate(get, accountAtom(key));
        }),
      ),
    ),
  ),
);
/** Remove the confirmed account and its selections without choosing a replacement. */
export const disconnectAccountAtom = (key: {
  organization: OrganizationReference;
  account: AccountId;
}) => disconnectAccount(new AccountKey(key));

/** Save safe metadata without inventing credential health or changing app selections. */
export function acknowledgeAccount(
  get: Atom.FnContext,
  organization: OrganizationReference,
  saved: Account,
  credentialsChanged = false,
) {
  refreshResourceDirectory(get, organization);
  acknowledge(get, accountAtom({ organization, account: saved.id }), (data) => ({
    ...data,
    account: saved,
  }));
  acknowledge(get, inventoryAtom(organization), (data) => ({
    ...data,
    accounts: upsert(data.accounts, saved),
  }));
  if (credentialsChanged) refreshCredentialDependents(get, organization, saved.id);
}

function refreshCredentialDependents(
  get: Atom.FnContext,
  organization: OrganizationReference,
  account: AccountId,
) {
  const inventory = AsyncResult.value(get(inventoryAtom(organization)));
  if (Option.isSome(inventory))
    for (const app of inventory.value.apps) {
      if (
        Object.values(app.accounts).some((selection) =>
          typeof selection === "string" ? selection === account : selection.includes(account),
        )
      ) {
        get.refresh(appAtom({ organization, app: app.id }));
        get.refresh(toolsAtom({ organization, app: app.id }));
      }
    }
}

/** Mirrors the confirmed hosted deletion contract, preserving other accounts and pre-existing explicit empty slots. */
function withoutAccount(app: App, removed: AccountId): App {
  const accounts: Record<string, AccountId | readonly AccountId[]> = {};
  for (const [slot, selected] of Object.entries(app.accounts)) {
    if (typeof selected === "string") {
      if (selected !== removed) accounts[slot] = selected;
    } else {
      const remaining = selected.filter((account) => account !== removed);
      if (selected.length === 0 || remaining.length > 0) accounts[slot] = remaining;
    }
  }
  return { ...app, accounts };
}
