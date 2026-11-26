import { type Duration, Effect } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ScheduleSettings, WebhookSubscription, WorkflowRun } from "@executor-js/sdk";

const reconcileInterval: Duration.Input = "30 seconds";
const activeInterval: Duration.Input = "5 seconds";

export interface PollingOptions<A> {
  readonly idle?: Duration.Input;
  readonly active?: (value: A) => boolean;
}
export const steadyPolling: PollingOptions<unknown> = { idle: activeInterval };

export const pollingQuery = <A>(
  source: Atom.Atom<A>,
  { idle = reconcileInterval, active }: PollingOptions<A> = {},
): Atom.Atom<A> =>
  Atom.readable(
    (get) => {
      const value = get(source);
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

export const whileLoaded =
  <A>(pending: (value: A) => boolean) =>
  <E>(result: AsyncResult.AsyncResult<A, E>) =>
    AsyncResult.isSuccess(result) && pending(result.value);

type Statuses<A extends { readonly status: string }> = ReadonlyArray<A["status"]>;
const withStatus =
  <A extends { readonly status: string }>(statuses: Statuses<A>) =>
  (rows: ReadonlyArray<A>) =>
    rows.some(({ status }) => statuses.includes(status));

export const unsettledWebhooks = whileLoaded(
  withStatus<WebhookSubscription>(["pending", "stopping"]),
);
export const unsettledRuns = whileLoaded((page: { readonly items: ReadonlyArray<WorkflowRun> }) =>
  withStatus<WorkflowRun>(["queued", "running", "waitingForPause"])(page.items),
);
export const runningSchedules = whileLoaded((rows: ReadonlyArray<ScheduleSettings>) =>
  rows.some(({ activeRun }) => activeRun !== null),
);
