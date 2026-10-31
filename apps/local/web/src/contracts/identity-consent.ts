/** Local browser commands preserve app scopes and reuse the existing OAuth return path. */
import { Effect } from "effect";
import type { AccountScope, AppId, OAuthClientSelection } from "@executor-js/sdk";
import type { IdentityConsentSelection } from "@executor-js/ui/contracts/identity-consent";
import { identityRequests } from "@executor-js/ui/contracts/identity-requests";
import { DashboardClient, overviewAtom } from "./api.ts";
import { accountCredentialsChanged } from "./accounts.ts";
import { refreshAppLinks } from "./app-accounts.ts";

export const identityConsentAtoms = (target: {
  readonly app: AppId;
  readonly scope: AccountScope;
  readonly requirement: string;
}) => {
  const prepare = identityRequests(target, (payload) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.createIdentityConnection({ payload }),
    ),
  );
  return {
    plan: DashboardClient.runtime.fn(
      (input: IdentityConsentSelection & { readonly method: string }) =>
        Effect.gen(function* () {
          const payload = { ...(yield* prepare(input)), method: input.method };
          return yield* (yield* DashboardClient).dashboard.planIdentityOAuth({ payload });
        }),
    ),
    reuse: DashboardClient.runtime.fn(
      (
        input: IdentityConsentSelection & {
          readonly method: string;
          readonly sourceAccount: NonNullable<IdentityConsentSelection["sourceAccount"]>;
        },
        get,
      ) =>
        Effect.gen(function* () {
          const prepared = yield* prepare(input);
          const result = yield* (yield* DashboardClient).dashboard.reuseIdentityOAuth({
            payload: { ...prepared, account: input.sourceAccount, method: input.method },
          });
          if (result.status === "completed") {
            accountCredentialsChanged(get, result.account);
            refreshAppLinks(get, target.app, target.requirement);
            get.refresh(overviewAtom);
          }
          return result;
        }),
    ),
    start: DashboardClient.runtime.fn(
      (
        input: IdentityConsentSelection & {
          readonly method: string;
          readonly client?: OAuthClientSelection | undefined;
        },
      ) =>
        Effect.gen(function* () {
          const payload = {
            ...(yield* prepare(input)),
            method: input.method,
            ...(input.client === undefined ? {} : { client: input.client }),
          };
          return yield* (yield* DashboardClient).dashboard.startIdentityOAuth({ payload });
        }),
    ),
  };
};
