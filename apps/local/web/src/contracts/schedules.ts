import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { browserApproval } from "@executor-js/ui/contracts/browser-approval";
import { BrowserAtoms } from "./telemetry.ts";
/** Product transport owns schedule atoms; each mutation belongs to one app and schedule. */
import type { AccountScope, AppId, ScheduleId, ScheduleSettings } from "@executor-js/sdk";
import { Data, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { acknowledge, acknowledgedQuery, upsert } from "@executor-js/ui/contracts/mutations";
import { pollingQuery, steadyPolling } from "@executor-js/ui/contracts/polling";
import type { ApprovalListItem } from "@executor-js/ui/contracts/schedules";
import { DashboardClient, overviewAtom } from "./api.ts";

class AppKey extends Data.Class<{ readonly app: AppId }> {}
class ScheduleKey extends Data.Class<{
  readonly app: AppId;
  readonly name: string;
  /** `app` configures the app declaration's one schedule; `user` the local subject's copy. */
  readonly scope: AccountScope;
}> {}
const settings = Atom.family((key: AppKey) =>
  DashboardClient.query("schedules", "list", hydrated({ params: key })).pipe(
    revalidated,
    acknowledgedQuery,
  ),
);
const polledSettings = Atom.family((key: AppKey) => pollingQuery(settings(key), steadyPolling));
const definitions = Atom.family((key: AppKey) =>
  DashboardClient.query("schedules", "definitions", hydrated({ params: key })).pipe(revalidated),
);
class CopyKey extends Data.Class<{
  readonly app: AppId;
  readonly name: string;
  readonly copy: ScheduleId;
}> {}
const acknowledgeSaved = (
  get: Atom.FnContext,
  app: AppId,
  change: (rows: readonly ScheduleSettings[]) => readonly ScheduleSettings[],
) => acknowledge(get, settings(new AppKey({ app })), change);
const controls = Atom.family((key: ScheduleKey) => ({
  configure: DashboardClient.runtime.fn(
    (
      payload: {
        readonly enabled: boolean;
        readonly approvalMode: "automatic" | "browser";
      },
      get,
    ) =>
      Effect.flatMap(DashboardClient, (client) =>
        client.schedules.configure({
          params: { app: key.app, name: key.name },
          payload: key.scope === "app" ? { ...payload, scope: "app" } : payload,
        }),
      ).pipe(
        Effect.tap((value) =>
          Effect.sync(() => acknowledgeSaved(get, key.app, (rows) => upsert(rows, value))),
        ),
      ),
  ),
}));
const copyControls = Atom.family((key: CopyKey) => ({
  update: DashboardClient.runtime.fn(
    (payload: { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" }, get) =>
      Effect.flatMap(DashboardClient, (client) =>
        client.schedules.update({ params: key, payload }),
      ).pipe(
        Effect.tap((value) =>
          Effect.sync(() => acknowledgeSaved(get, key.app, (rows) => upsert(rows, value))),
        ),
      ),
  ),
  runNow: DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) => client.schedules.runCopy({ params: key })).pipe(
      Effect.tap((value) =>
        Effect.sync(() => acknowledgeSaved(get, key.app, (rows) => upsert(rows, value))),
      ),
    ),
  ),
  remove: DashboardClient.runtime.fn((_: void, get) =>
    Effect.flatMap(DashboardClient, (client) => client.schedules.remove({ params: key })).pipe(
      Effect.tap((value) =>
        Effect.sync(() =>
          acknowledgeSaved(get, key.app, (rows) => rows.filter((row) => row.id !== value.id)),
        ),
      ),
    ),
  ),
}));
/**
 * Read the app's schedules again, as after linking or unlinking an account: the app's declarations
 * are evaluated with its linked accounts.
 */
export const refreshScheduleDiscovery = (get: Atom.FnContext, app: AppId) => {
  get.refresh(definitions(new AppKey({ app })));
  get.refresh(settings(new AppKey({ app })));
};
/** Bind saved settings independently from account-dependent definition discovery. */
/** The local subject controls the app's own schedules as well as its copies. */
export const scheduleBindings = (key: { readonly app: AppId }) => ({
  settings: polledSettings(new AppKey({ app: key.app })),
  definitions: definitions(new AppKey({ app: key.app })),
  manageApp: true,
  controls: {
    declaration: (name: string, scope: AccountScope) =>
      controls(new ScheduleKey({ app: key.app, name, scope })),
    copy: (name: string, copy: ScheduleId) =>
      copyControls(new CopyKey({ app: key.app, name, copy })),
  },
});
const runsSource = DashboardClient.query(
  "schedules",
  "runs",
  hydrated({ query: { pending: true } }),
).pipe(revalidated, acknowledgedQuery);
const runsQuery = pollingQuery(runsSource, steadyPolling);
/** Join safe run metadata with app names; keep either read failure visible. */
export const pendingApprovalsAtom = DashboardClient.runtime.atom((get) =>
  Effect.gen(function* () {
    const runs = yield* get.result(runsQuery);
    const inventory = yield* get.result(overviewAtom);
    return runs.map((run): ApprovalListItem => ({
      run,
      app: {
        id: run.app,
        name: inventory.apps.find((app) => app.id === run.app)?.name ?? "App unavailable",
      },
    }));
  }),
);

/** An answered request leaves the shared queue before the page reports success. */
export const scheduledReviewAtoms = Atom.family((id: string) =>
  browserApproval(
    BrowserAtoms,
    `/dashboard/api/scheduled-runs/${encodeURIComponent(id)}/approval`,
    (get) => acknowledge(get, runsSource, (runs) => runs.filter((run) => run.id !== id)),
  ),
);
