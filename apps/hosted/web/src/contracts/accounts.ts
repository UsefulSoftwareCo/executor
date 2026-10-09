import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { refreshProfiles } from "./profiles.ts";
import { acknowledgeResourceAccount, resourceDirectoryAtom } from "./resource-access.ts";
import { protectedQuery } from "./protected-query.ts";
/** Account queries remain independent across organizations, including OAuth returns. */
import type { Account, AccountFieldsInput, AccountId, AppId, ProviderId } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { Data, Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { acknowledge, upsert, invalidate } from "@executor-js/ui/contracts/mutations";
import type { AccountToName } from "@executor-js/ui/dashboard/name-account";
import type { AccountMetadataUpdate } from "@executor-js/ui/dashboard/account-description";
import { HostedClient } from "./api.ts";
import { inventoryAtom } from "./organization.ts";
import { toolsAtom } from "./apps.ts";

class AccountKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly account: AccountId;
}> {}
const accountQuery = Atom.family((key: AccountKey) =>
  HostedClient.query("accounts", "get", hydrated({ params: key })).pipe(
    revalidated,
    protectedQuery,
  ),
);
export const accountAtom = (key: {
  readonly organization: OrganizationReference;
  readonly account: AccountId;
}) => accountQuery(new AccountKey(key));
const updateAccount = Atom.family((key: AccountKey) =>
  HostedClient.runtime.fn((payload: AccountMetadataUpdate, get) =>
    Effect.flatMap(HostedClient, (client) => client.accounts.update({ params: key, payload })).pipe(
      Effect.tap((saved) => Effect.sync(() => acknowledgeAccount(get, key.organization, saved))),
    ),
  ),
);
const checkAccount = Atom.family((key: AccountKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.accounts.check({ params: key })).pipe(
      Effect.tap((health) =>
        Effect.sync(() => {
          acknowledge(get, accountAtom(key), (data) => ({ ...data, health }));
          // The account list reads the resource directory; reload it for the recorded results.
          get.refresh(resourceDirectoryAtom(key.organization));
          get.refresh(resourceDirectoryAtom(key.organization, "managed"));
          acknowledge(get, inventoryAtom(key.organization), (data) => ({
            ...data,
            accounts: data.accounts.map((current) =>
              current.id === key.account ? { ...current, health } : current,
            ),
          }));
        }),
      ),
    ),
  ),
);
/** Run the checks of the apps this member can use; the account query shows the results. */
export const checkAccountAtom = (key: {
  organization: OrganizationReference;
  account: AccountId;
}) => checkAccount(new AccountKey(key));
/**
 * A new account waiting to be named. The organization layout shows the prompt, so page refreshes
 * after saving, and the OAuth return navigation, cannot dismiss it.
 */
export const accountToNameAtom = Atom.make<
  (AccountToName & { readonly organization: OrganizationReference }) | undefined
>(undefined).pipe(Atom.keepAlive);
/** A different account cannot supersede this account's name or description update. */
export const updateAccountAtom = (key: {
  organization: OrganizationReference;
  account: AccountId;
}) => updateAccount(new AccountKey(key));
/** A fresh read of which apps select an account, taken after a selection change commits. */
export const accountUsageAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.fn((account: AccountId) =>
    Effect.flatMap(HostedClient, (client) =>
      client.accounts.get({ params: { organization, account } }),
    ),
  ),
);
const disconnectAccount = Atom.family((key: AccountKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.accounts.disconnect({ params: key })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          refreshCredentialDependents(get, key.organization, key.account);
          acknowledgeResourceAccount(get, key.organization, key.account, undefined);
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
  acknowledgeResourceAccount(get, organization, saved.id, saved);
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

/**
 * Check unsaved credentials with an app's check. A newer check replaces an older one still
 * running, which is what a form checking its latest input wants.
 */
export const checkCredentialsAtom = HostedClient.runtime.fn(
  (input: {
    readonly organization: OrganizationReference;
    readonly app: AppId;
    readonly provider: ProviderId;
    readonly method: string;
    readonly fields: typeof AccountFieldsInput.Type;
  }) =>
    Effect.flatMap(HostedClient, (client) =>
      client.accounts.checkCredentials({
        params: { organization: input.organization, app: input.app },
        payload: { provider: input.provider, method: input.method, fields: input.fields },
      }),
    ),
);
