/** Typed account management; successful responses contain metadata only. */
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
/**
 * A new account waiting to be named. The dashboard layout shows the prompt, so page refreshes
 * after saving, and the OAuth return navigation, cannot dismiss it.
 */
export const accountToNameAtom = Atom.make<AccountToName | undefined>(undefined).pipe(
  Atom.keepAlive,
);
/** Each account owns its pending update; metadata is confirmed before the editor resets. */
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
/**
 * Run the apps' checks of an account. The detail query is live, so it also follows the recorded
 * results; acknowledging them here keeps the page from showing the old ones meanwhile.
 */
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
/** A fresh read of which apps select an account, taken after a selection change commits. */
export const accountUsageAtom = DashboardClient.runtime.fn((account: AccountId) =>
  Effect.flatMap(DashboardClient, (client) => client.dashboard.account({ params: { account } })),
);
/** Preserve unresolved app selections when their saved account is removed. */
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
/**
 * All dashboard credential paths invalidate unknown health and account-dependent catalogs.
 * The inventory gates every dashboard page, so it reloads in place instead of being cleared.
 */
export function accountCredentialsChanged(get: Atom.FnContext | Atom.AtomContext, saved: Account) {
  refreshCredentialDependents(get, saved.id);
  invalidate(get, accountAtom(saved.id));
  get.registry.refresh(overviewAtom);
}
function refreshCredentialDependents(get: Atom.FnContext | Atom.AtomContext, account: AccountId) {
  const inventory = AsyncResult.value(get.registry.get(overviewAtom));
  if (Option.isSome(inventory))
    for (const profile of inventory.value.profiles)
      if (
        Object.values(profile.accounts).some((selection) =>
          typeof selection === "string" ? selection === account : selection.includes(account),
        )
      )
        get.registry.refresh(
          toolsAtom({ app: profile.app, profile: profile.id, revision: profile.revision }),
        );
}

/**
 * Check unsaved credentials with an app's check. One shared call: a newer check replaces an
 * older one still running, which is what a form checking its latest input wants.
 */
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
