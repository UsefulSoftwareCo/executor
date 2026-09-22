/** Adapt the local API once. Live streams remain live; no hosted concepts enter these contracts. */
import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { RemoteCustomAppInput } from "@executor-js/catalog/contracts";
import type { InstallApp } from "@executor-js/ui/contracts/dashboard";
import type { AppId, SelectedAccounts } from "@executor-js/sdk";
import { DashboardClient, overviewAtom, toolsAtom } from "./api.ts";
import { acknowledgeApp } from "./apps.ts";
import { catalogAtom } from "./onboarding.ts";

/** Local streams and commands fulfill the common display contract. */
export const dashboardAtoms = {
  inventory: overviewAtom,
  catalog: catalogAtom,
  tools: Atom.family((app: AppId) =>
    Atom.map(
      toolsAtom({ app: app }),
      AsyncResult.map((value) => value.tools),
    ),
  ),
  install: DashboardClient.runtime.fn((input: InstallApp, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.importApp({ payload: input }),
    ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeApp(get, saved)))),
  ),
  importCustom: DashboardClient.runtime.fn((input: RemoteCustomAppInput, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.importCustomApp({ payload: { source: input } }),
    ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeApp(get, saved)))),
  ),
  selectAccounts: DashboardClient.runtime.fn(
    (input: { readonly app: AppId; readonly accounts: SelectedAccounts }, get) =>
      Effect.flatMap(DashboardClient, (client) =>
        client.dashboard.selectAccounts({
          params: { app: input.app },
          payload: { accounts: input.accounts },
        }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            acknowledgeApp(get, saved);
            get.refresh(toolsAtom({ app: input.app }));
          }),
        ),
      ),
  ),
};
