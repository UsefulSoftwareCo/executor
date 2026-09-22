/** Typed product calls for catalog import and reusable account setup. */
import type { Provider, AppId, AccountFieldsInput, ProviderId } from "@executor-js/sdk";
import type { DashboardOverview } from "@executor-js/local-server/contracts";
import { DashboardClient, appAtom, overviewAtom, toolsAtom } from "./api.ts";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { acknowledge, invalidate } from "@executor-js/ui/contracts/mutations";
import { accountAtom, accountCredentialsChanged } from "./accounts.ts";
import { selectedIds } from "@executor-js/ui/contracts/dashboard";

/** Catalog metadata is loaded independently of installed apps. */
export const catalogAtom = DashboardClient.query("dashboard", "catalog", {});
/** Generate ordinary app source from a user-supplied endpoint or API definition. */
export const importCustomAppAtom = DashboardClient.mutation("dashboard", "importCustomApp");
/** Fields travel through the redacted API contract and are absent from successful responses. */
export const addAccountAtom = DashboardClient.runtime.fn(
  (
    input: {
      payload: {
        provider: ProviderId;
        method: string;
        label: string;
        fields: typeof AccountFieldsInput.Type;
      };
    },
    get,
  ) =>
    Effect.flatMap(DashboardClient, (client) => client.dashboard.addAccount(input)).pipe(
      Effect.tap((saved) => Effect.sync(() => accountCredentialsChanged(get, saved))),
    ),
);
/** Delete one configured copy without deleting its reusable accounts or other apps. */
export const deleteAppAtom = Atom.family((app: AppId) =>
  DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.deleteApp({ params: { app } }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const current = AsyncResult.value(get(appAtom(app)));
          acknowledge(get, overviewAtom, (data) => ({
            ...data,
            apps: data.apps.filter((current) => current.id !== app),
          }));
          if (Option.isSome(current))
            for (const account of selectedIds(current.value.app))
              acknowledge(get, accountAtom(account), (data) => ({
                ...data,
                apps: data.apps.filter((current) => current.id !== app),
              }));
          invalidate(get, appAtom(app));
          get.refresh(toolsAtom({ app: app }));
        }),
      ),
    ),
  ),
);

/** Only installed app definitions offer standalone account methods. */
export const installedProviders = (data: DashboardOverview): readonly Provider[] => [
  ...new Map(
    data.apps.flatMap((app) =>
      Object.values(app.requirements.accounts).map(
        (requirement) =>
          [
            requirement.provider,
            {
              id: requirement.provider,
              definition: requirement.definition,
            },
          ] as const,
      ),
    ),
  ).values(),
];

export {
  accountFields,
  credentialValues,
  credentialsComplete,
  type AccountFormFields,
} from "@executor-js/ui/contracts/credentials";
