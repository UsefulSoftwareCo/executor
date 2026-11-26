import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { acknowledgeLinkChecks, refreshAppLinks } from "./app-accounts.ts";
import { discoveryTarget, refreshAppDiscovery } from "./app-discovery.ts";
import { linkedAccountIds } from "@executor-js/ui/contracts/app-accounts";
import { acknowledgeResourceAccount, resourceDirectoryAtom } from "./resource-access.ts";
import { protectedQuery } from "./protected-query.ts";
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
const runCheck = (get: Atom.FnContext, key: AccountKey) =>
  Effect.flatMap(HostedClient, (client) => client.accounts.check({ params: key })).pipe(
    Effect.tap((health) =>
      Effect.sync(() => {
        acknowledge(get, accountAtom(key), (data) => ({ ...data, health }));
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
  );
const checkAccount = Atom.family((key: AccountKey) =>
  HostedClient.runtime.fn((_: void, get) => runCheck(get, key)),
);
export const checkAccountAtom = (key: {
  organization: OrganizationReference;
  account: AccountId;
}) => checkAccount(new AccountKey(key));
class AppAccountKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly account: AccountId;
}> {}
const checkAppAccount = Atom.family((key: AppAccountKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    runCheck(get, new AccountKey({ organization: key.organization, account: key.account })).pipe(
      Effect.tap((health) =>
        Effect.sync(() =>
          acknowledgeLinkChecks(get, { organization: key.organization, app: key.app }, health),
        ),
      ),
    ),
  ),
);
export const checkAppAccountAtom = (key: {
  organization: OrganizationReference;
  app: AppId;
  account: AccountId;
}) => checkAppAccount(new AppAccountKey(key));
export const accountToNameAtom = Atom.make<
  (AccountToName & { readonly organization: OrganizationReference }) | undefined
>(undefined).pipe(Atom.keepAlive);
export const updateAccountAtom = (key: {
  organization: OrganizationReference;
  account: AccountId;
}) => updateAccount(new AccountKey(key));
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
export const disconnectAccountAtom = (key: {
  organization: OrganizationReference;
  account: AccountId;
}) => disconnectAccount(new AccountKey(key));

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
    for (const app of inventory.value.apps)
      if (linkedAccountIds(inventory.value.links, app.id).includes(account)) {
        refreshAppLinks(get, {
          organization,
          app: app.id,
          requirements: app.requirements.accounts,
        });
        get.refresh(toolsAtom({ organization, app: app.id }));
        refreshAppDiscovery(get, discoveryTarget(organization, app));
      }
}

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
