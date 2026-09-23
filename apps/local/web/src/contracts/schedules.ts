import { browserApproval } from "@executor-js/ui/contracts/browser-approval";
import { BrowserAtoms } from "./telemetry.ts";
/** Product transport owns schedule atoms; each mutation belongs to one app and schedule. */
import type { AppId, ProfileId, ScheduleSettings } from "@executor-js/sdk";
import { Data, Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { acknowledge, acknowledgedQuery, upsert } from "@executor-js/ui/contracts/mutations";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import type { ApprovalListItem } from "@executor-js/ui/contracts/schedules";
import { DashboardClient, overviewAtom } from "./api.ts";

class AppKey extends Data.Class<{
  readonly profile?: ProfileId | undefined;
  readonly app: AppId;
}> {}
class ScheduleKey extends Data.Class<{
  readonly profile?: ProfileId | undefined;
  readonly app: AppId;
  readonly name: string;
}> {}
const settings = Atom.family((key: AppKey) =>
  DashboardClient.query("schedules", "list", {
    params: key,
    query: { profile: key.profile },
  }).pipe(Atom.refreshOnWindowFocus, acknowledgedQuery),
);
const polledSettings = Atom.family((key: AppKey) => pollingQuery(settings(key)));
const definitions = Atom.family((key: AppKey) =>
  DashboardClient.query("schedules", "definitions", {
    params: key,
    query: { profile: key.profile },
  }).pipe(Atom.refreshOnWindowFocus),
);
const controls = Atom.family((key: ScheduleKey) => {
  const saved = (get: Atom.FnContext, value: ScheduleSettings) =>
    acknowledge(get, settings(new AppKey({ app: key.app, profile: key.profile })), (rows) =>
      upsert(rows, value),
    );
  return {
    configure: DashboardClient.runtime.fn(
      (
        payload: { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" },
        get,
      ) =>
        Effect.flatMap(DashboardClient, (client) =>
          client.schedules.configure({
            params: key,
            payload: { ...payload, profile: key.profile },
          }),
        ).pipe(Effect.tap((value) => Effect.sync(() => saved(get, value)))),
    ),
    runNow: DashboardClient.runtime.fn((_: void, get) =>
      Effect.flatMap(DashboardClient, (client) =>
        client.schedules.runNow({ params: key, query: { profile: key.profile } }),
      ).pipe(Effect.tap((value) => Effect.sync(() => saved(get, value)))),
    ),
  };
});
/** Bind saved settings independently from account-dependent definition discovery. */
export const scheduleBindings = (
  key: { readonly profile?: ProfileId | undefined; readonly app: AppId },
  editable = true,
) => ({
  settings: polledSettings(new AppKey(key)),
  definitions: definitions(new AppKey(key)),
  ...(editable ? { controls: (name: string) => controls(new ScheduleKey({ ...key, name })) } : {}),
});
const runsSource = DashboardClient.query("schedules", "runs", { query: { pending: true } }).pipe(
  Atom.refreshOnWindowFocus,
  acknowledgedQuery,
);
const runsQuery = pollingQuery(runsSource);
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
