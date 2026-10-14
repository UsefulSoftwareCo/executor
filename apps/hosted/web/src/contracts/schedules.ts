import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { protectedQuery } from "./protected-query.ts";
import { browserApproval } from "@executor-js/ui/contracts/browser-approval";
import { BrowserAtoms } from "./telemetry.ts";
/** Product transport owns schedule atoms; each mutation belongs to one app and schedule. */
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
  /** `app` configures the app declaration's one schedule; `user` the caller's own copy. */
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
/**
 * Read the app's schedules again, as after the caller links or unlinks an account: the app's
 * declarations are evaluated with its linked accounts.
 */
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
/** Bind saved settings independently from account-dependent definition discovery. */
export const scheduleBindings = (
  key: {
    readonly organization: OrganizationReference;
    readonly app: AppId;
  },
  editable = true,
  /** Whether the caller manages the app, and so controls its app schedules. */
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
  // Approval requests expire, and this queue exists to receive them.
  pollingQuery(runsSource(organization), steadyPolling),
);
/** Join safe run metadata with app names; keep either read failure visible. */
export const pendingApprovalsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.atom((get) =>
    Effect.gen(function* () {
      // App names come from the inventory; read it alongside the runs rather than after them.
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
/** An answered request leaves the shared queue before the page reports success. */
export const scheduledReviewAtoms = (key: {
  readonly organization: OrganizationReference;
  readonly run: string;
}) => review(new ReviewKey(key));
