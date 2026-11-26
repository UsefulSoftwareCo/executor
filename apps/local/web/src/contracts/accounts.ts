import type { Account, AccountId, AccountFieldsInput, AppId, ProviderId } from "@executor-js/sdk";
import { DashboardAccountDetail } from "@executor-js/local-server/contracts";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { acknowledge, acknowledgedQuery, invalidate } from "@executor-js/ui/contracts/mutations";
import type { AccountToName } from "@executor-js/ui/dashboard/name-account";
import type { AccountMetadataUpdate } from "@executor-js/ui/dashboard/account-description";
import { DashboardClient, liveQueryAtom, overviewAtom, toolsAtom } from "./api.ts";

export const accountAtom = Atom.family((account: AccountId) =>
  liveQueryAtom({
    name: "account",
    key: { account },
    success: DashboardAccountDetail,
    query: Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.liveAccount({ params: { account } }),
    ),
  }).pipe(acknowledgedQuery),
);
export const accountToNameAtom = Atom.make<AccountToName | undefined>(undefined).pipe(
  Atom.keepAlive,
);
export const updateAccountAtom = Atom.family((account: AccountId) =>
  DashboardClient.runtime.fn((payload: AccountMetadataUpdate, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.updateAccount({ params: { account }, payload }),
    ).pipe(
      Effect.tap((saved) =>
        Effect.sync(() => {
          acknowledge(get, accountAtom(account), (data) => ({
            ...data,
            account: { ...data.account, ...saved },
          }));
          acknowledge(get, overviewAtom, (data) => ({
            ...data,
            accounts: data.accounts.map((current) =>
              current.id === saved.id ? { ...current, ...saved } : current,
            ),
          }));
        }),
      ),
    ),
  ),
);
export const checkAccountAtom = Atom.family((account: AccountId) =>
  DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.checkAccount({ params: { account } }),
    ).pipe(
      Effect.tap((health) =>
        Effect.sync(() => {
          acknowledge(get, accountAtom(account), (data) => ({ ...data, health }));
          acknowledge(get, overviewAtom, (data) => ({
            ...data,
            accounts: data.accounts.map((current) =>
              current.id === account ? { ...current, health } : current,
            ),
          }));
        }),
      ),
    ),
  ),
);
export const accountUsageAtom = DashboardClient.runtime.fn((account: AccountId) =>
  Effect.flatMap(DashboardClient, (client) => client.dashboard.account({ params: { account } })),
);
export const disconnectAccountAtom = Atom.family((account: AccountId) =>
  DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.disconnectAccount({ params: { account } }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          refreshCredentialDependents(get, account);
          acknowledge(get, overviewAtom, (data) => ({
            ...data,
            accounts: data.accounts.filter((current) => current.id !== account),
          }));
          invalidate(get, accountAtom(account));
        }),
      ),
    ),
  ),
);
export function accountCredentialsChanged(get: Atom.FnContext | Atom.AtomContext, saved: Account) {
  refreshCredentialDependents(get, saved.id);
  invalidate(get, accountAtom(saved.id));
  get.registry.refresh(overviewAtom);
}
function refreshCredentialDependents(get: Atom.FnContext | Atom.AtomContext, account: AccountId) {
  const inventory = AsyncResult.value(get.registry.get(overviewAtom));
  if (Option.isSome(inventory))
    for (const link of inventory.value.links)
      if (link.account === account) get.registry.refresh(toolsAtom({ app: link.app }));
}

export const checkCredentialsAtom = DashboardClient.runtime.fn(
  (input: {
    readonly app: AppId;
    readonly provider: ProviderId;
    readonly method: string;
    readonly fields: typeof AccountFieldsInput.Type;
  }) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.checkCredentials({
        params: { app: input.app },
        payload: { provider: input.provider, method: input.method, fields: input.fields },
      }),
    ),
);
