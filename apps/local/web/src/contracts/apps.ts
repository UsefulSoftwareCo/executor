import type { App, AppId } from "@executor-js/sdk";
import { Effect, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { acknowledge, upsert } from "@executor-js/ui/contracts/mutations";
import { selectedIds } from "@executor-js/ui/contracts/dashboard";
import { DashboardClient, appAtom, overviewAtom } from "./api.ts";
import { accountAtom } from "./accounts.ts";

/** App metadata changes use the same live subscriptions as other SDK writes. */
export const renameAppAtom = Atom.family((app: AppId) =>
  DashboardClient.runtime.fn((name: string, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.renameApp({ params: { app }, payload: { name } }),
    ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeApp(get, saved)))),
  ),
);

/** Saved app metadata is shared immediately while stream snapshots reconcile it. */
export function acknowledgeApp(get: Atom.FnContext, saved: App) {
  const inventory = AsyncResult.value(get(overviewAtom));
  const profiles = Option.isSome(inventory)
    ? inventory.value.profiles.filter((profile) => profile.app === saved.id)
    : [];
  const accounts = new Set(profiles.flatMap((profile) => selectedIds(profile.accounts)));
  acknowledge(get, appAtom(saved.id), (data) => ({ ...data, app: saved }));
  acknowledge(get, overviewAtom, (data) => ({ ...data, apps: upsert(data.apps, saved) }));
  for (const account of accounts)
    acknowledge(get, accountAtom(account), (data) => ({
      ...data,
      apps: upsert(data.apps, saved),
    }));
}
