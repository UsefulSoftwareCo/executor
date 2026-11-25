import { browserOnly } from "@executor-js/ui/contracts/http";
import type { AppId } from "@executor-js/sdk";
import { DashboardClient, appAtom, overviewAtom, toolsAtom } from "./api.ts";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { acknowledge, invalidate } from "@executor-js/ui/contracts/mutations";
import { accountAtom } from "./accounts.ts";
import { linkedAccountIds } from "@executor-js/ui/contracts/app-accounts";

export const catalogAtom = browserOnly(DashboardClient.query("dashboard", "catalog", {}));
export const importCustomAppAtom = DashboardClient.mutation("dashboard", "importCustomApp");
export const deleteAppAtom = Atom.family((app: AppId) =>
  DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.deleteApp({ params: { app } }),
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const current = AsyncResult.value(get(overviewAtom));
          acknowledge(get, overviewAtom, (data) => ({
            ...data,
            apps: data.apps.filter((current) => current.id !== app),
            links: data.links.filter((link) => link.app !== app),
            appLinks: data.appLinks.filter((link) => link.app !== app),
          }));
          if (Option.isSome(current))
            for (const account of new Set([
              ...linkedAccountIds(current.value.links, app),
              ...current.value.appLinks.flatMap((link) => (link.app === app ? [link.account] : [])),
            ]))
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

export {
  accountFields,
  credentialValues,
  credentialsComplete,
  type AccountFormFields,
} from "@executor-js/ui/contracts/credentials";
