import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { protectedQuery } from "./protected-query.ts";
import { browserApproval } from "@executor-js/ui/contracts/browser-approval";
import { BrowserAtoms } from "./telemetry.ts";
import type { AccountScope, AppId, ScheduleId, ScheduleSettings } from "@executor-js/sdk";
import { Data, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { acknowledge, upsert } from "@executor-js/ui/contracts/mutations";
import { pollingQuery, runningSchedules, steadyPolling } from "@executor-js/ui/contracts/polling";
import type { ApprovalListItem } from "@executor-js/ui/contracts/schedules";
import { HostedClient } from "./api.ts";
import { OrganizationReference } from "@executor-js/hosted-server/organization";
import { inventoryAtom } from "./organization.ts";

class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
}> {}
class ScheduleKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly name: string;
  readonly scope: AccountScope;
}> {}
const settings = Atom.family((key: AppKey) =>
  HostedClient.query("schedules", "list", hydrated({ params: key })).pipe(
    revalidated,
    protectedQuery,
  ),
);
const polledSettings = Atom.family((key: AppKey) =>
  pollingQuery(settings(key), { active: runningSchedules }),
);
const definitions = Atom.family((key: AppKey) =>
  HostedClient.query("schedules", "definitions", hydrated({ params: key })).pipe(revalidated),
);
export const refreshScheduleDiscovery = (
  get: Atom.FnContext,
  key: { readonly organization: OrganizationReference; readonly app: AppId },
) => {
  get.refresh(definitions(new AppKey(key)));
  get.refresh(settings(new AppKey(key)));
};
class CopyKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly name: string;
  readonly copy: ScheduleId;
}> {}
const acknowledgeSaved = (
  get: Atom.FnContext,
  key: { readonly organization: OrganizationReference; readonly app: AppId },
  change: (rows: readonly ScheduleSettings[]) => readonly ScheduleSettings[],
) =>
  acknowledge(get, settings(new AppKey({ organization: key.organization, app: key.app })), change);
const controls = Atom.family((key: ScheduleKey) => ({
  configure: HostedClient.runtime.fn(
    (
      payload: {
        readonly enabled: boolean;
        readonly approvalMode: "automatic" | "browser";
      },
      get,
    ) =>
      Effect.flatMap(HostedClient, (client) =>
        client.schedules.configure({
          params: { organization: key.organization, app: key.app, name: key.name },
          payload: key.scope === "app" ? { ...payload, scope: "app" } : payload,
        }),
      ).pipe(
        Effect.tap((value) =>
          Effect.sync(() => acknowledgeSaved(get, key, (rows) => upsert(rows, value))),
        ),
      ),
  ),
}));
const copyControls = Atom.family((key: CopyKey) => ({
  update: HostedClient.runtime.fn(
    (payload: { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" }, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.schedules.update({ params: key, payload }),
      ).pipe(
        Effect.tap((value) =>
          Effect.sync(() => acknowledgeSaved(get, key, (rows) => upsert(rows, value))),
        ),
      ),
  ),
  runNow: HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.schedules.runCopy({ params: key })).pipe(
      Effect.tap((value) =>
        Effect.sync(() => acknowledgeSaved(get, key, (rows) => upsert(rows, value))),
      ),
    ),
  ),
  remove: HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.schedules.remove({ params: key })).pipe(
      Effect.tap((value) =>
        Effect.sync(() =>
          acknowledgeSaved(get, key, (rows) => rows.filter((row) => row.id !== value.id)),
        ),
      ),
    ),
  ),
}));
export const scheduleBindings = (
  key: {
    readonly organization: OrganizationReference;
    readonly app: AppId;
  },
  editable = true,
  manageApp = false,
) => {
  const app = { organization: key.organization, app: key.app };
  return {
    settings: polledSettings(new AppKey(app)),
    definitions: definitions(new AppKey(app)),
    manageApp,
    ...(editable
      ? {
          controls: {
            declaration: (name: string, scope: AccountScope) =>
              controls(new ScheduleKey({ ...app, name, scope })),
            copy: (name: string, copy: ScheduleId) =>
              copyControls(new CopyKey({ ...app, name, copy })),
          },
        }
      : {}),
  };
};
const runsSource = Atom.family((organization: OrganizationReference) =>
  HostedClient.query(
    "schedules",
    "runs",
    hydrated({
      params: { organization },
      query: { pending: true },
    }),
  ).pipe(revalidated, protectedQuery),
);
const runsQuery = Atom.family((organization: OrganizationReference) =>
  pollingQuery(runsSource(organization), steadyPolling),
);
export const pendingApprovalsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.atom((get) =>
    Effect.gen(function* () {
      const [runs, inventory] = yield* Effect.all(
        [get.result(runsQuery(organization)), get.result(inventoryAtom(organization))],
        { concurrency: "unbounded" },
      );
      return runs.map((run): ApprovalListItem => ({
        run,
        app: {
          id: run.app,
          name: inventory.apps.find((app) => app.id === run.app)?.name ?? "App unavailable",
        },
      }));
    }),
  ),
);

class ReviewKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly run: string;
}> {}
const review = Atom.family((key: ReviewKey) =>
  browserApproval(
    BrowserAtoms,
    `/api/organizations/${encodeURIComponent(key.organization)}/scheduled-runs/${encodeURIComponent(key.run)}/approval`,
    (get) =>
      acknowledge(get, runsSource(key.organization), (runs) =>
        runs.filter((run) => run.id !== key.run),
      ),
  ),
);
export const scheduledReviewAtoms = (key: {
  readonly organization: OrganizationReference;
  readonly run: string;
}) => review(new ReviewKey(key));
