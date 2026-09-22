/** Typed account management; successful responses contain metadata only. */
import type { Account, AccountId, AccountFieldsInput, OAuthClientInput } from "@executor-js/sdk";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { acknowledge, acknowledgedQuery, invalidate } from "@executor-js/ui/contracts/mutations";
import { DashboardClient, liveQueryAtom, overviewAtom, toolsAtom } from "./api.ts";

export const accountAtom = Atom.family((account: AccountId) =>
  liveQueryAtom(
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.liveAccount({ params: { account } }),
    ),
  ).pipe(acknowledgedQuery),
);
/** Each account owns its pending rename; metadata is confirmed before the editor resets. */
export const renameAccountAtom = Atom.family((account: AccountId) =>
  DashboardClient.runtime.fn((label: string, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.renameAccount({ params: { account }, payload: { label } }),
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
/** Credential responses do not prove provider health; reload those projections. */
export const replaceAccountCredentialsAtom = Atom.family((account: AccountId) =>
  DashboardClient.runtime.fn((fields: typeof AccountFieldsInput.Type, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.replaceAccountCredentials({ params: { account }, payload: { fields } }),
    ).pipe(Effect.tap((saved) => Effect.sync(() => accountCredentialsChanged(get, saved)))),
  ),
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
export const reconnectAccountAtom = DashboardClient.runtime.fn(
  (
    input: {
      params: { account: AccountId };
      payload: { client?: OAuthClientInput };
    },
    get,
  ) =>
    Effect.flatMap(DashboardClient, (client) => client.dashboard.reconnectAccount(input)).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.status === "completed") accountCredentialsChanged(get, result.account);
        }),
      ),
    ),
);

/** All dashboard credential paths invalidate unknown health and account-dependent catalogs. */
export function accountCredentialsChanged(get: Atom.FnContext | Atom.AtomContext, saved: Account) {
  refreshCredentialDependents(get, saved.id);
  invalidate(get, accountAtom(saved.id));
  invalidate(get, overviewAtom);
}
function refreshCredentialDependents(get: Atom.FnContext | Atom.AtomContext, account: AccountId) {
  const inventory = AsyncResult.value(get.registry.get(overviewAtom));
  if (Option.isSome(inventory))
    for (const app of inventory.value.apps)
      if (
        Object.values(app.accounts).some((selection) =>
          typeof selection === "string" ? selection === account : selection.includes(account),
        )
      )
        get.registry.refresh(toolsAtom({ app: app.id }));
}
