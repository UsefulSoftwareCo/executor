import { refreshProfiles } from "./profiles.ts";
import { refreshResourceDirectory } from "./resource-access.ts";
import { protectedQuery } from "./protected-query.ts";
/** Account queries remain independent across organizations, including OAuth returns. */
import type { Account, AccountId } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { Data, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { acknowledge, upsert, invalidate } from "@executor-js/ui/contracts/mutations";
import { HostedClient } from "./api.ts";
import { inventoryAtom } from "./organization.ts";
import { connectionAtom, toolsAtom } from "./apps.ts";

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
/** Resolves once the dialog's connection is loaded, so it opens without a skeleton. */
export const reconnectAccountAtom = HostedClient.runtime.fn(
  (key: { readonly organization: OrganizationReference; readonly account: AccountId }, get) =>
    Effect.gen(function* () {
      const client = yield* HostedClient;
      const pending = yield* client.accounts.reconnect({ params: key });
      return yield* get.result(
        connectionAtom({ organization: key.organization, connection: pending.id }),
      );
    }),
);
const disconnectAccount = Atom.family((key: AccountKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.accounts.disconnect({ params: key })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          refreshResourceDirectory(get, key.organization);
          refreshCredentialDependents(get, key.organization, key.account);
          acknowledge(get, inventoryAtom(key.organization), (data) => ({
            ...data,
            accounts: data.accounts.filter((account) => account.id !== key.account),
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
    for (const profile of inventory.value.profiles) {
      if (
        Object.values(profile.accounts).some((selection) =>
          typeof selection === "string" ? selection === account : selection.includes(account),
        )
      ) {
        refreshProfiles(get, { organization, app: profile.app });
        get.refresh(
          toolsAtom({
            organization,
            app: profile.app,
            profile: profile.id,
            expectedProfileRevision: profile.revision,
          }),
        );
      }
    }
}
