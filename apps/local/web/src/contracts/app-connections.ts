/**
 * Every dashboard sign-in fills one app requirement. The server saves the account and selects it
 * for the profile in one step; credentials are never entered outside an app.
 */
import { Effect } from "effect";
import type { Atom } from "effect/reactivity";
import type {
  Account,
  AccountFieldsInput,
  AccountId,
  AppId,
  OAuthClientInput,
  ProfileId,
  SelectedAccounts,
} from "@executor-js/sdk";
import { DashboardClient, toolsAtom } from "./api.ts";
import { accountCredentialsChanged } from "./accounts.ts";
import { createProfile, profileSelectionChanged } from "./profiles.ts";

/**
 * One dialog's connection for an app requirement. Without a profile, the first attempt creates
 * one with the shown selection; retries reuse it. `account` replaces that account's credentials.
 */
export function appConnectionAtoms(key: {
  readonly app: AppId;
  readonly requirement: string;
  readonly profile: ProfileId | undefined;
  readonly accounts: SelectedAccounts;
  readonly account?: AccountId | undefined;
}) {
  const idempotencyKey = crypto.randomUUID();
  let profile = key.profile;
  const target = (get: Atom.FnContext) =>
    Effect.gen(function* () {
      profile ??= (yield* createProfile(get, {
        app: key.app,
        accounts: key.accounts,
        idempotencyKey,
      })).id;
      return {
        profile,
        requirement: key.requirement,
        ...(key.account === undefined ? {} : { account: key.account }),
      };
    });
  const saved = (get: Atom.FnContext, account: Account) => {
    accountCredentialsChanged(get, account);
    profileSelectionChanged(get, key.app);
    get.refresh(toolsAtom({ app: key.app }));
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
          const payload = { ...(yield* target(get)), ...input };
          const client = yield* DashboardClient;
          const account = yield* client.dashboard.connectAccount({
            params: { app: key.app },
            payload,
          });
          saved(get, account);
          return { account, profile: payload.profile };
        }),
    ),
    startOAuth: DashboardClient.runtime.fn(
      (
        input: {
          readonly method: string;
          readonly label?: string;
          readonly client?: OAuthClientInput;
        },
        get,
      ) =>
        Effect.gen(function* () {
          const payload = { ...(yield* target(get)), ...input };
          const client = yield* DashboardClient;
          const signIn = yield* client.dashboard.startOAuth({
            params: { app: key.app },
            payload,
          });
          if (signIn.status === "completed") saved(get, signIn.account);
          return { ...signIn, profile: payload.profile };
        }),
    ),
  };
}
