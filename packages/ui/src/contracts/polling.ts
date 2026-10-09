/** Poll only while a view is mounted; query refresh and mutation acknowledgement remain on the source atom. */
import { type Duration, Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { Profile, ScheduleSettings, WebhookSubscription, WorkflowRun } from "@executor-js/sdk";

/** Idle reconciliation for writes made outside this tab; focus and acknowledged writes cover the rest. */
const reconcileInterval: Duration.Input = "30 seconds";
/** Server work the user is watching, such as provisioning or a running workflow, settles sooner. */
const activeInterval: Duration.Input = "5 seconds";

export interface PollingOptions<A> {
  /** Interval while no unfinished work is reported; hosted reads default to 30 seconds. */
  readonly idle?: Duration.Input;
  /** Use the 5-second interval while the current value reports unfinished server work. */
  readonly active?: (value: A) => boolean;
}
/**
 * Keep the 5-second interval while visible. For queues that exist to receive external
 * arrivals, and for the local dashboard, whose reads stay on the user's machine.
 */
export const steadyPolling: PollingOptions<unknown> = { idle: activeInterval };

/**
 * Periodic dashboard reconciliation (see the level 3 freshness decision): read the
 * authoritative source again while the page is visible. The source keeps its own
 * focus refresh, so returning to a hidden tab reconciles immediately. Every source
 * update restarts the timer, so a focus or mutation refresh is not followed by a
 * redundant poll.
 */
export const pollingQuery = <A>(
  source: Atom.Atom<A>,
  { idle = reconcileInterval, active }: PollingOptions<A> = {},
): Atom.Atom<A> =>
  Atom.readable(
    (get) => {
      const value = get(source);
      // A server render reads once; only a visible page keeps reconciling.
      if (typeof window === "undefined") return value;
      get.addFinalizer(
        Effect.runCallback(
          Effect.forever(
            Effect.sleep(active?.(value) ? activeInterval : idle).pipe(
              Effect.andThen(() =>
                Effect.sync(() => {
                  if (document.visibilityState === "visible") get.refresh(source);
                }),
              ),
            ),
          ),
        ),
      );
      return value;
    },
    (refresh) => refresh(source),
  );

/** Select the faster interval while a loaded result reports unfinished server work. */
export const whileLoaded =
  <A>(pending: (value: A) => boolean) =>
  <E>(result: AsyncResult.AsyncResult<A, E>) =>
    AsyncResult.isSuccess(result) && pending(result.value);

type Statuses<A extends { readonly status: string }> = ReadonlyArray<A["status"]>;
const withStatus =
  <A extends { readonly status: string }>(statuses: Statuses<A>) =>
  (rows: ReadonlyArray<A>) =>
    rows.some(({ status }) => statuses.includes(status));

/** Profiles still being set up or removed by the server. */
export const unsettledProfiles = whileLoaded(withStatus<Profile>(["pending", "removing"]));
/** Webhook subscriptions still registering or unregistering upstream. */
export const unsettledWebhooks = whileLoaded(
  withStatus<WebhookSubscription>(["pending", "stopping"]),
);
/** Runs in a short transition; long waits and pauses use idle reconciliation. */
export const unsettledRuns = whileLoaded((page: { readonly items: ReadonlyArray<WorkflowRun> }) =>
  withStatus<WorkflowRun>(["queued", "running", "waitingForPause"])(page.items),
);
/** Schedules with a run in progress. */
export const runningSchedules = whileLoaded((rows: ReadonlyArray<ScheduleSettings>) =>
  rows.some(({ activeRun }) => activeRun !== null),
);
