import { Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { CustomAppInput } from "@executor-js/catalog/contracts";
import type { InstallApp } from "@executor-js/ui/contracts/dashboard";
import type { AppId } from "@executor-js/sdk";
import { DashboardClient, overviewAtom, toolsAtom } from "./api.ts";
import { acknowledgeApp } from "./apps.ts";
import { catalogAtom } from "./onboarding.ts";

export const dashboardAtoms = {
  inventory: overviewAtom,
  catalog: catalogAtom,
  tools: Atom.family((app: AppId) =>
    Atom.map(
      toolsAtom({ app: app }),
      AsyncResult.map((value) => value.tools),
    ),
  ),
  install: Atom.family((_entry: string) =>
    DashboardClient.runtime.fn((input: InstallApp, get) =>
      Effect.flatMap(DashboardClient, (client) =>
        client.dashboard.importApp({ payload: input }),
      ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeApp(get, saved)))),
    ),
  ),
  importCustom: DashboardClient.runtime.fn((input: CustomAppInput, get) =>
    Effect.flatMap(DashboardClient, (client) =>
      client.dashboard.importCustomApp({ payload: { source: input } }),
    ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeApp(get, saved)))),
  ),
};
