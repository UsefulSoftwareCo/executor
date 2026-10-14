/**
 * Every dashboard sign-in fills one app requirement, in the scope the dialog names: saving the
 * account links it to that requirement. Credentials are never entered outside an app.
 */
import { Effect } from "effect";
import type { Atom } from "effect/reactivity";
import type {
  Account,
  AccountFieldsInput,
  AccountId,
  AccountScope,
  AppId,
  DeploymentId,
  OAuthClientSelection,
} from "@executor-js/sdk";
import { DashboardClient } from "./api.ts";
import { accountCredentialsChanged } from "./accounts.ts";
import { refreshAppLinks } from "./app-accounts.ts";
import { refreshAppDiscovery } from "./app-discovery.ts";

/** One dialog's connection for an app requirement. `account` replaces that account's credentials. */
export function appConnectionAtoms(key: {
  readonly app: AppId;
  /** The deployment whose discovery the page shows, read again once the account is linked. */
  readonly deployment: DeploymentId | null;
  readonly scope: AccountScope;
  readonly requirement: string;
  readonly account?: AccountId | undefined;
}) {
  const params = { app: key.app, requirement: key.requirement };
  const target = key.account === undefined ? {} : { account: key.account };
  const saved = (get: Atom.FnContext, account: Account) => {
    accountCredentialsChanged(get, account);
    refreshAppLinks(get, key.app, key.requirement);
    refreshAppDiscovery(get, key);
  };
  return {
    submit: DashboardClient.runtime.fn(
      (
        input: {
          readonly method: string;
          readonly label?: string;
          readonly fields: typeof AccountFieldsInput.Type;
        },
        get,
      ) =>
        Effect.gen(function* () {
          const client = yield* DashboardClient;
          const request = { params, payload: { ...target, ...input } };
          const account = yield* key.scope === "app"
            ? client.dashboard.appConnect(request)
            : client.dashboard.userConnect(request);
          saved(get, account);
          return account;
        }),
    ),
    startOAuth: DashboardClient.runtime.fn(
      (
        input: {
          readonly method: string;
          readonly label?: string;
          readonly client?: OAuthClientSelection;
        },
        get,
      ) =>
        Effect.gen(function* () {
          const client = yield* DashboardClient;
          const request = { params, payload: { ...target, ...input } };
          const signIn = yield* key.scope === "app"
            ? client.dashboard.appConnectOAuth(request)
            : client.dashboard.userConnectOAuth(request);
          if (signIn.status === "completed") saved(get, signIn.account);
          return signIn;
        }),
    ),
  };
}
