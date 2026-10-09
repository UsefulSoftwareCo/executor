/** Typed product calls for catalog import and reusable account setup. */
import { browserOnly } from "@executor-js/ui/contracts/http";
import type { AppId } from "@executor-js/sdk";
import { DashboardClient, appAtom, overviewAtom, toolsAtom } from "./api.ts";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { acknowledge, invalidate } from "@executor-js/ui/contracts/mutations";
import { accountAtom } from "./accounts.ts";
import { selectedIds } from "@executor-js/ui/contracts/dashboard";

/** Catalog metadata is loaded independently of installed apps. */
/**
 * The full catalog is large and only decorates icons and the add-app page, so the browser loads
 * it after the page is interactive instead of the server embedding it in every document.
 */
export const catalogAtom = browserOnly(DashboardClient.query("dashboard", "catalog", {}));
/** Generate ordinary app source from a user-supplied endpoint or API definition. */
export const importCustomAppAtom = DashboardClient.mutation("dashboard", "importCustomApp");
/** Delete one configured copy without deleting its reusable accounts or other apps. */
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
            profiles: data.profiles.filter((profile) => profile.app !== app),
          }));
          if (Option.isSome(current))
            for (const account of current.value.profiles
              .filter((profile) => profile.app === app)
              .flatMap((profile) => selectedIds(profile.accounts)))
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
