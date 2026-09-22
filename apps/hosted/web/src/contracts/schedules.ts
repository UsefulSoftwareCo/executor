import { protectedQuery } from "./protected-query.ts";
import { browserApproval } from "@executor-js/ui/contracts/browser-approval";
import { BrowserAtoms } from "./telemetry.ts";
/** Product transport owns schedule atoms; each mutation belongs to one app and schedule. */
import type { AppId, ProfileId, ScheduleSettings } from "@executor-js/sdk";
import { Data, Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { acknowledge, upsert } from "@executor-js/ui/contracts/mutations";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import type { ApprovalListItem } from "@executor-js/ui/contracts/schedules";
import { HostedClient } from "./api.ts";
import { OrganizationReference } from "@executor-js/hosted-server/organization";
import { inventoryAtom } from "./organization.ts";

class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly profile?: ProfileId | undefined;
  readonly app: AppId;
}> {}
class ScheduleKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly profile?: ProfileId | undefined;
  readonly app: AppId;
  readonly name: string;
}> {}
const settings = Atom.family((key: AppKey) =>
  HostedClient.query("schedules", "list", {
    params: key,
    query: { profile: key.profile },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const polledSettings = Atom.family((key: AppKey) => pollingQuery(settings(key)));
const definitions = Atom.family((key: AppKey) =>
  HostedClient.query("schedules", "definitions", {
    params: key,
    query: { profile: key.profile },
  }).pipe(Atom.refreshOnWindowFocus),
);
const controls = Atom.family((key: ScheduleKey) => {
  const saved = (get: Atom.FnContext, value: ScheduleSettings) =>
    acknowledge(
      get,
      settings(
        new AppKey({
          organization: key.organization,
          app: key.app,
          profile: key.profile,
        }),
      ),
      (rows) => upsert(rows, value),
    );
  return {
    configure: HostedClient.runtime.fn(
      (
        payload: { readonly enabled: boolean; readonly approvalMode: "automatic" | "browser" },
        get,
      ) =>
        Effect.flatMap(HostedClient, (client) =>
          client.schedules.configure({
            params: key,
            payload: { ...payload, profile: key.profile },
          }),
        ).pipe(Effect.tap((value) => Effect.sync(() => saved(get, value)))),
    ),
    runNow: HostedClient.runtime.fn((_: void, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.schedules.runNow({ params: key, query: { profile: key.profile } }),
      ).pipe(Effect.tap((value) => Effect.sync(() => saved(get, value)))),
    ),
  };
});
/** Bind saved settings independently from account-dependent definition discovery. */
export const scheduleBindings = (
  key: {
    readonly organization: OrganizationReference;
    readonly profile?: ProfileId | undefined;
    readonly app: AppId;
  },
  editable = true,
) => ({
  settings: polledSettings(new AppKey(key)),
  definitions: definitions(new AppKey(key)),
  ...(editable ? { controls: (name: string) => controls(new ScheduleKey({ ...key, name })) } : {}),
});
const runsSource = Atom.family((organization: OrganizationReference) =>
  HostedClient.query("schedules", "runs", {
    params: { organization },
    query: { pending: true },
  }).pipe(Atom.refreshOnWindowFocus, protectedQuery),
);
const runsQuery = Atom.family((organization: OrganizationReference) =>
  pollingQuery(runsSource(organization)),
);
/** Join safe run metadata with app names; keep either read failure visible. */
export const pendingApprovalsAtom = Atom.family((organization: OrganizationReference) =>
  HostedClient.runtime.atom((get) =>
    Effect.gen(function* () {
      const runs = yield* get.result(runsQuery(organization));
      const inventory = yield* get.result(inventoryAtom(organization));
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
