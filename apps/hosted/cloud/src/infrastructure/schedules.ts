import { cloudArtifactsTokensLive } from "./artifacts-tokens.ts";
import { dispatchBackground } from "../implementation/background-dispatch.ts";
import { makeScheduleDispatch } from "../implementation/schedule-dispatch.ts";
import { cloudSentry } from "../implementation/error-reporting.ts";
import { cloudAnalytics, recordBackgroundUsage } from "../implementation/product-analytics.ts";
import { ScheduleObservation } from "@executor-js/sdk/scheduling";
import { previewLifetime } from "./test-stage-expiry.ts";
import { EventCleanup } from "./event-cleanup.ts";
import { WebhookSourceHost } from "@executor-js/sdk/core";
import {
  cloudScheduleConcurrency,
  heldAlarmMilliseconds,
  scheduleRecoveryMilliseconds,
} from "../contracts/schedules.ts";
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Clock, Duration, Effect, Exit, Layer, Semaphore } from "effect";
import { HostedExecutor, ScheduledAuthority, ScheduleWakeup } from "@executor-js/hosted-server";
import { defaultScheduleWorkerOptions } from "@executor-js/sdk/scheduling";
import { cloudProduct } from "./product.ts";
import { lookupColo } from "./colo.ts";
import { appDataSupervisors } from "./app-data.ts";
import { cloudAuthDatabase } from "./auth-database.ts";
import { cloudBackgroundJobs } from "./background-jobs.ts";
import { cloudDirectDatabaseConnection } from "./database.ts";
import { cloudObjectDatabase, ObjectDatabase } from "./object-database.ts";

const coordinatorName = "coordinator";

const retiredName = "executor";

const handoverKey = "handover";

const restoreKey = "restore";

interface WakeAlarm {
  readonly at: number;
  readonly pending: number | null;
  readonly armed: number;
}

type WakeSource = "change" | "job";

const makePlacedScheduleCoordinator = Effect.gen(function* () {
  const analytics = yield* cloudAnalytics;
  const report = yield* cloudSentry;
  const resources = yield* cloudProduct(yield* appDataSupervisors, yield* cloudArtifactsTokensLive);
  const objectDatabase = yield* cloudObjectDatabase(cloudDirectDatabaseConnection);
  const retired = yield* ScheduleCoordinator;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lifetime = yield* previewLifetime;
    const database = yield* objectDatabase("schedules", Duration.zero);
    const pool = yield* Semaphore.make(cloudScheduleConcurrency);
    const lifecycle = yield* Semaphore.make(1);
    const alarms = yield* Semaphore.make(1);
    const restoring = yield* Semaphore.make(1);
    const dispatch = yield* makeScheduleDispatch;
    const colo = yield* Effect.cached(lookupColo);
    let initialized = false;
    let heartbeat = false;
    let alarmEvents = 0;
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(resources), Effect.provideService(ObjectDatabase, database));
    const retire = Effect.suspend(() => retired.getByName(retiredName).retire()).pipe(
      Effect.provide(RuntimeContext.phantom),
    );
    const restored = Effect.suspend(() => {
      heartbeat = true;
      return state.storage.delete(restoreKey);
    });
    const handover = Effect.gen(function* () {
      if ((yield* state.storage.get<number>(handoverKey)) !== undefined) return yield* retire;
      yield* Effect.gen(function* () {
        yield* retire;
        yield* state.storage.put(handoverKey, yield* Clock.currentTimeMillis);
      }).pipe(Effect.withSpan("schedule.handover"));
    });
    const attempt = Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.scoped(report(handover.pipe(Effect.timeout("10 seconds")))),
      );
      if (Exit.isSuccess(exit)) return yield* restored;
      const retry = (yield* Clock.currentTimeMillis) + scheduleRecoveryMilliseconds;
      yield* Effect.annotateCurrentSpan("executor.schedule.restore.retry", retry);
      yield* alarms.withPermits(1)(
        Effect.gen(function* () {
          yield* state.storage.put(restoreKey, retry);
          const pending = yield* state.storage.getAlarm();
          if (pending === null || pending > retry) yield* state.storage.setAlarm(retry);
        }),
      );
      yield* Effect.logError("Retired coordinator heartbeat failed");
    }).pipe(Effect.withSpan("schedule.restore"));
    const restore = restoring.withPermits(1)(
      Effect.gen(function* () {
        if (heartbeat) return;
        const due = yield* state.storage.get<number>(restoreKey);
        if (due === undefined || (yield* Clock.currentTimeMillis) >= due) yield* attempt;
      }),
    );
    /**
     * Writes a new time over a stored alarm well past its time while no alarm event runs. Such an
     * alarm is held: the runtime can schedule a later time than the one it stores and reports
     * (cloudflare/workerd#7330), and only writing a different time schedules it again. Before this,
     * a held alarm left every wake waiting for the later time, up to the minute recovery alarm.
     */
    const rearm = (now: number, pending: number) =>
      state.storage
        .setAlarm(now)
        .pipe(
          Effect.andThen(
            Effect.logWarning("Schedule alarm held past its time", { lateMs: now - pending }),
          ),
        );
    const stop = alarms.withPermits(1)(
      Effect.gen(function* () {
        heartbeat = false;
        yield* state.storage.delete(restoreKey);
        yield* state.storage.deleteAlarm();
      }),
    );
    const arm = alarms.withPermits(1)(
      provide(
        Effect.gen(function* () {
          const executor = yield* Effect.flatten(HostedExecutor);
          const [schedule, delivery] = yield* Effect.all(
            [executor.scheduler.nextWake, executor.events.nextWake],
            { concurrency: "unbounded" },
          );
          const next =
            schedule === null || delivery === null
              ? (schedule ?? delivery)
              : schedule < delivery
                ? schedule
                : delivery;
          const soonest =
            (yield* Clock.currentTimeMillis) + defaultScheduleWorkerOptions.pollMilliseconds;
          const planned = (yield* dispatch.requested)
            ? soonest
            : next === null
              ? undefined
              : Math.max(next.getTime(), soonest);
          const stored = yield* state.storage.get<number>(restoreKey);
          const retry = stored === undefined ? undefined : Math.max(stored, soonest);
          const due =
            planned === undefined || retry === undefined
              ? (planned ?? retry)
              : Math.min(planned, retry);
          if (due === undefined) yield* state.storage.deleteAlarm();
          else yield* state.storage.setAlarm(due);
        }),
      ),
    );
    const run = Effect.scoped(
      analytics.wrap(
        provide(
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            const authorize = yield* ScheduledAuthority;
            yield* Effect.annotateCurrentSpan("executor.schedule.runner", "cloud");
            yield* Effect.all(
              [
                colo.pipe(
                  Effect.flatMap((code) => Effect.annotateCurrentSpan("cloudflare.colo", code)),
                ),
                lifecycle.withPermits(1)(
                  Effect.gen(function* () {
                    if (initialized) return;
                    yield* restore;
                    yield* executor.scheduler.recover("cloud");
                    initialized = true;
                  }),
                ),
              ],
              { concurrency: "unbounded", discard: true },
            );
            yield* dispatch.run(
              executor[WebhookSourceHost].tick(defaultScheduleWorkerOptions.concurrency),
              executor.scheduler.tick({
                runner: "cloud",
                maxCandidates: cloudScheduleConcurrency,
                authorize,
                execute: (operation) =>
                  pool.withPermitsIfAvailable(1)(operation).pipe(Effect.asVoid),
              }),
            );
            yield* executor.events.deliver({ maxDeliveries: 64 }).pipe(
              Effect.withSpan("events.dispatch"),
              Effect.catch(() => Effect.logError("Cloud event delivery failed")),
            );
            yield* arm;
          }),
        ).pipe(
          Effect.provideService(ScheduleObservation, {
            completed: (run) =>
              recordBackgroundUsage("schedule_run_completed", run.owner, {
                run_id: run.id,
                schedule_id: run.scheduleId,
                app_id: run.app,
                status: run.status,
                outcome:
                  run.status === "succeeded"
                    ? "success"
                    : run.status === "cancelled"
                      ? "cancelled"
                      : "failure",
                ok: run.status === "succeeded",
                duration_ms:
                  run.finishedAt === null
                    ? 0
                    : Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime()),
              }),
          }),
        ),
      ),
    ).pipe(
      lifetime.background,
      report,
      Effect.scoped,
      Effect.withSpan("schedule.dispatch"),
      Effect.catch(() => Effect.logError("Cloud scheduled dispatch failed")),
    );
    return {
      wake: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isBackgroundStopped) return yield* stop;
          yield* restore;
          return yield* alarms.withPermits(1)(
            Effect.gen(function* () {
              yield* dispatch.request;
              const now = yield* Clock.currentTimeMillis;
              const due = now + defaultScheduleWorkerOptions.pollMilliseconds;
              const pending = yield* state.storage.getAlarm();
              const armed =
                pending === null || pending > due
                  ? due
                  : alarmEvents === 0 && pending < now - heldAlarmMilliseconds
                    ? now
                    : pending;
              if (pending === null || pending > due) yield* state.storage.setAlarm(due);
              else if (armed !== pending) yield* rearm(now, pending);
              return { at: now, pending, armed } satisfies WakeAlarm;
            }),
          );
        }),
      alarm: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isBackgroundStopped) return yield* stop;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              alarmEvents += 1;
            }),
            () =>
              Effect.sync(() => {
                alarmEvents -= 1;
              }),
          );
          yield* alarms.withPermits(1)(
            Effect.gen(function* () {
              yield* state.storage.setAlarm(
                (yield* Clock.currentTimeMillis) + scheduleRecoveryMilliseconds,
              );
            }),
          );
          yield* dispatchBackground(run, state.waitUntil);
          if (!heartbeat) yield* dispatchBackground(restore, state.waitUntil);
          yield* Effect.scoped(arm).pipe(
            lifetime.background,
            report,
            Effect.scoped,
            Effect.withSpan("schedule.plan"),
            Effect.catch(() => Effect.logError("Schedule alarm planning failed")),
          );
        }),
    };
  });
}).pipe(Effect.provide(cloudAuthDatabase), Effect.orDie);

const makeRetiredScheduleCoordinator = Effect.gen(function* () {
  const jobs = yield* cloudBackgroundJobs;
  const report = yield* cloudSentry;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lifetime = yield* previewLifetime;
    const heartbeat = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* state.storage.setAlarm(now + scheduleRecoveryMilliseconds);
      yield* Effect.annotateCurrentSpan({
        "executor.schedule.heartbeat.at": now,
        "executor.schedule.heartbeat.armed": now + scheduleRecoveryMilliseconds,
      });
    });
    // Keeps the next alarm at most a minute away. It never moves an earlier one later, so frequent
    // wakes cannot postpone it, and brings a later one in, such as old code's alarm for an hourly
    // schedule, so a revert never waits for it. One well past its time is held by the runtime
    // (cloudflare/workerd#7330); writing it again for now schedules it.
    const keep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const due = now + scheduleRecoveryMilliseconds;
      const pending = yield* state.storage.getAlarm();
      const armed =
        pending === null || pending > due
          ? due
          : pending < now - heldAlarmMilliseconds
            ? now
            : pending;
      if (armed !== pending) yield* state.storage.setAlarm(armed);
      yield* Effect.annotateCurrentSpan({
        "executor.schedule.heartbeat.at": now,
        "executor.schedule.heartbeat.armed": armed,
        ...(pending === null ? {} : { "executor.schedule.heartbeat.pending": pending }),
      });
    });
    const forward = Effect.scoped(report(jobs.request("schedule-wake"))).pipe(
      Effect.catch(() => Effect.logError("Retired coordinator forward failed")),
    );
    const retired = (wake: "wake" | "alarm") =>
      Effect.withSpan("schedule.retired", { attributes: { "executor.schedule.wake": wake } });
    return {
      retire: () => keep.pipe(Effect.withSpan("schedule.retire")),
      wake: () => keep.pipe(Effect.andThen(forward), retired("wake")),
      alarm: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isBackgroundStopped) {
            yield* state.storage.deleteAlarm();
            return;
          }
          yield* heartbeat;
          yield* forward;
        }).pipe(retired("alarm")),
    };
  });
});

export class ScheduleCoordinator extends Cloudflare.DurableObject<
  ScheduleCoordinator,
  Effect.Success<Effect.Success<typeof makeRetiredScheduleCoordinator>>
>()("ScheduleCoordinator") {}

export const ScheduleCoordinatorLive = ScheduleCoordinator.make(makeRetiredScheduleCoordinator);

class PlacedScheduleCoordinator extends Cloudflare.DurableObject<
  PlacedScheduleCoordinator,
  Effect.Success<Effect.Success<typeof makePlacedScheduleCoordinator>>
>()("PlacedScheduleCoordinator") {}

export const PlacedScheduleCoordinatorLive = PlacedScheduleCoordinator.make(
  makePlacedScheduleCoordinator,
);

export const cloudSchedules = Effect.gen(function* () {
  const coordinator = yield* PlacedScheduleCoordinator;
  const report = yield* cloudSentry;
  const lifetime = yield* previewLifetime;
  const cleanup = yield* EventCleanup;
  const wake = (source: WakeSource) =>
    Effect.scoped(report(Effect.suspend(() => coordinator.getByName(coordinatorName).wake()))).pipe(
      Effect.flatMap((alarm) =>
        alarm === undefined
          ? Effect.void
          : Effect.annotateCurrentSpan({
              "executor.schedule.wake.at": alarm.at,
              "executor.schedule.wake.armed": alarm.armed,
              ...(alarm.pending === null
                ? {}
                : { "executor.schedule.wake.pending": alarm.pending }),
            }),
      ),
      Effect.withSpan("schedule.wake", { attributes: { "executor.schedule.wake": source } }),
      Effect.provide(RuntimeContext.phantom),
    );
  const change = wake("change").pipe(
    Effect.catch(() => Effect.logError("Schedule coordinator wake failed")),
  );
  const afterResponse = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const deadline = yield* cleanup.deadline;
      yield* Effect.addFinalizer(() =>
        deadline.within(change, { max: "5 seconds" }).pipe(Effect.asVoid),
      );
    }),
  );
  return {
    layer: Layer.succeed(ScheduleWakeup, afterResponse),
    immediateLayer: Layer.succeed(ScheduleWakeup, change),
    wake: wake("job").pipe(lifetime.background),
  };
});
