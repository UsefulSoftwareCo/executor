import { cloudArtifactsTokensLive } from "./artifacts-tokens.ts";
import { dispatchBackground } from "../implementation/background-dispatch.ts";
import { makeScheduleDispatch } from "../implementation/schedule-dispatch.ts";
import { cloudSentry } from "../implementation/error-reporting.ts";
import { cloudAnalytics, recordBackgroundUsage } from "../implementation/product-analytics.ts";
import { ScheduleObservation } from "@executor-js/sdk/scheduling";
import { previewLifetime } from "./test-stage-expiry.ts";
import { EventCleanup } from "./event-cleanup.ts";
import { ProfileHost } from "@executor-js/sdk/core";
import { scheduleRecoveryMilliseconds } from "../contracts/schedules.ts";
/** Native alarms wake one coordinator; authoritative schedule/run state remains in Postgres. */
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Config, Clock, Effect, Exit, Layer, Schema, Semaphore } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HostedExecutor, ScheduledAuthority, ScheduleWakeup } from "@executor-js/hosted-server";
import { defaultScheduleWorkerOptions } from "@executor-js/sdk/scheduling";
import { cloudProduct } from "./product.ts";
import { appDataSupervisors } from "./app-data.ts";
import { cloudAuthDatabase } from "./auth-database.ts";
import { cloudBackgroundJobs } from "./background-jobs.ts";
import { cloudObjectDatabase, ObjectDatabase } from "./object-database.ts";

/**
 * The coordinator's name in {@link PlacedScheduleCoordinator}. A Durable Object stays where it is
 * first created, and every statement of every scheduled run is a round trip from there to the
 * database. Only placed code may create it: placed fetch handlers wake it directly, and anything
 * else (Cron Triggers, workflow steps, the retired coordinator) asks the placed handler to through
 * the `schedule-wake` job. It has no location hint. A first call from a placed Worker creates an
 * object 3 to 8 ms from the database, while `enam` spreads objects from Ashburn to Miami, up to
 * 30 ms away, wherever the caller is.
 */
const coordinatorName = "coordinator";

/** The retired coordinator in {@link ScheduleCoordinator}. */
const retiredName = "executor";

/** Storage key: when this object retired the first coordinator. */
const handoverKey = "handover";

/**
 * Storage key: when a failed re-arm of the retired coordinator's heartbeat is next tried. While it
 * is set, this object's alarm is at or before it.
 */
const restoreKey = "restore";

/** Who asked for a wake: a change in a placed request, or the `schedule-wake` job. */
type WakeSource = "change" | "job";

/** The data center this instance runs in, recorded on its dispatches. */
const lookupColo = HttpClient.get("https://cloudflare.com/cdn-cgi/trace").pipe(
  Effect.flatMap((response) => response.text),
  Effect.map((trace) => /^colo=([A-Z]+)$/m.exec(trace)?.[1] ?? "unknown"),
  Effect.timeout("5 seconds"),
  Effect.catchCause(() => Effect.succeed("unknown")),
  Effect.provide(FetchHttpClient.layer),
);

const makePlacedScheduleCoordinator = Effect.gen(function* () {
  const analytics = yield* cloudAnalytics;
  const report = yield* cloudSentry;
  const resources = yield* cloudProduct(yield* appDataSupervisors, yield* cloudArtifactsTokensLive);
  const concurrency = yield* Config.Number("EXECUTOR_SCHEDULE_CONCURRENCY").pipe(
    Config.withDefault(defaultScheduleWorkerOptions.concurrency),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Int.check(Schema.isGreaterThan(0)))),
    Effect.orDie,
  );
  const objectDatabase = yield* cloudObjectDatabase;
  const retired = yield* ScheduleCoordinator;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lifetime = yield* previewLifetime;
    // Alarms, wakes and the dispatched runs share the coordinator's held connections.
    const database = yield* objectDatabase("schedules");
    const pool = yield* Semaphore.make(concurrency);
    const lifecycle = yield* Semaphore.make(1);
    const alarms = yield* Semaphore.make(1);
    const restoring = yield* Semaphore.make(1);
    const dispatch = yield* makeScheduleDispatch;
    const colo = yield* Effect.cached(lookupColo);
    let initialized = false;
    // Whether this instance has armed the retired coordinator's heartbeat since background work
    // last stopped, which deletes it.
    let heartbeat = false;
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provide(resources), Effect.provideService(ObjectDatabase, database));
    const retire = Effect.suspend(() => retired.getByName(retiredName).retire()).pipe(
      Effect.provide(RuntimeContext.phantom),
    );
    const restored = Effect.suspend(() => {
      heartbeat = true;
      return state.storage.delete(restoreKey);
    });
    /**
     * Calls `retire()`. The first answer to this object is its handover: `executor` answers in new
     * code, which never dispatches, so from then on only this object starts runs. Runs old code may
     * still be finishing are recovered on the first pass, as after any deploy.
     */
    const handover = Effect.gen(function* () {
      if ((yield* state.storage.get<number>(handoverKey)) !== undefined) return yield* retire;
      yield* Effect.gen(function* () {
        yield* retire;
        yield* state.storage.put(handoverKey, yield* Clock.currentTimeMillis);
      }).pipe(Effect.withSpan("schedule.handover"));
    });
    /**
     * Re-arms the retired coordinator's heartbeat, which a stopped background deletes, unless this
     * instance already has, and hands over on the first answer. Every wake runs this before it
     * arms this object, so a revert, which deletes this object with its alarm, finds `executor`
     * armed, and the first pass waits for it. A failed attempt is tried again at most once a
     * minute, not on every pass: its deadline is stored, and this object's alarm is kept at or
     * before it, so it is tried again even when nothing is planned.
     */
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
    /** A stopped background deletes both objects' alarms, as before the handover. */
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
          // Event deliveries due for a retry wake this coordinator too.
          const [schedule, delivery] = yield* Effect.all([
            executor.scheduler.nextWake,
            executor.events.nextWake,
          ]);
          const next =
            schedule === null || delivery === null
              ? (schedule ?? delivery)
              : schedule < delivery
                ? schedule
                : delivery;
          // Requested profile setup keeps its wake: deleting it, or moving it to a later
          // schedule, would leave the change to that schedule or the minute heartbeat.
          const soonest =
            (yield* Clock.currentTimeMillis) + defaultScheduleWorkerOptions.pollMilliseconds;
          const planned = (yield* dispatch.requested)
            ? soonest
            : next === null
              ? undefined
              : Math.max(next.getTime(), soonest);
          // A pending re-arm of the retired heartbeat keeps an alarm for its retry.
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
            yield* Effect.annotateCurrentSpan({
              "executor.schedule.runner": "cloud",
              "cloudflare.colo": yield* colo,
            });
            yield* lifecycle.withPermits(1)(
              Effect.gen(function* () {
                if (initialized) return;
                // One bounded attempt at most, unless a wake's attempt failed and its retry is not
                // due. Dispatch then proceeds: Postgres claims keep each occurrence to one run
                // even if old code still answers, and the stored retry hands over later.
                yield* restore;
                yield* executor.scheduler.recover("cloud");
                initialized = true;
              }),
            );
            // Alarm callbacks own this work through waitUntil; new wakes can discover other due apps meanwhile.
            yield* dispatch.run(
              executor[ProfileHost].tick(concurrency),
              executor.scheduler.tick({
                runner: "cloud",
                maxCandidates: concurrency,
                authorize,
                execute: (operation) =>
                  pool.withPermitsIfAvailable(1)(operation).pipe(Effect.asVoid),
              }),
            );
            // Each emit attempts its deliveries at once; this retries the ones still due.
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
          // `executor` is armed before this object is. A failed attempt arms this object for its retry.
          yield* restore;
          yield* alarms.withPermits(1)(
            Effect.gen(function* () {
              // Profile changes wake the coordinator; the request outlives a pass already running.
              yield* dispatch.request;
              // A wake only brings the alarm in. Wakes arrive from every write in every
              // organization; when each one moved the alarm a second out, wakes under a second
              // apart kept it from ever firing, and due runs waited up to a minute for a lull.
              const due =
                (yield* Clock.currentTimeMillis) + defaultScheduleWorkerOptions.pollMilliseconds;
              const pending = yield* state.storage.getAlarm();
              if (pending === null || pending > due) yield* state.storage.setAlarm(due);
            }),
          );
        }),
      alarm: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isBackgroundStopped) return yield* stop;
          // A durable recovery wake remains if storage is temporarily unavailable or this event crashes.
          yield* alarms.withPermits(1)(
            Effect.gen(function* () {
              yield* state.storage.setAlarm(
                (yield* Clock.currentTimeMillis) + scheduleRecoveryMilliseconds,
              );
            }),
          );
          yield* dispatchBackground(run, state.waitUntil);
          // A later instance, such as the first after a resume, or a failed attempt's retry
          // re-arms the heartbeat beside the dispatch rather than before it.
          if (!heartbeat) yield* dispatchBackground(restore, state.waitUntil);
          // Keep considering unclaimed due work while admitted runs are waiting on external I/O.
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

/**
 * The first coordinator, the object named `executor`, sat about 30 ms from the database. It now
 * only retires: it never dispatches, and keeps its alarm as a heartbeat that forwards a wake to the
 * coordinator through the placed handler every minute. Wakes from older callers are forwarded the
 * same way. Its alarm is at most a minute away whenever background work runs: only a stopped
 * background deletes it, and each coordinator instance re-arms it. Code without the coordinator,
 * after a revert, finds it armed and resumes dispatching within a minute, as after any deploy. A
 * forward that fails is repeated by the next heartbeat. Remove it only once no deploy can revert to
 * code before the coordinator.
 */
const makeRetiredScheduleCoordinator = Effect.gen(function* () {
  const jobs = yield* cloudBackgroundJobs;
  const report = yield* cloudSentry;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lifetime = yield* previewLifetime;
    // Spans record the clock, the alarm found and the alarm left, so the deadlines can be checked
    // without timing the runtime's callbacks.
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
    // schedule, so a revert never waits for it.
    const keep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const due = now + scheduleRecoveryMilliseconds;
      const pending = yield* state.storage.getAlarm();
      const armed = pending === null || pending > due ? due : pending;
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
      /**
       * The coordinator's handover, then each coordinator instance before it arms itself. Answering
       * at all proves this object runs new code.
       */
      retire: () => keep.pipe(Effect.withSpan("schedule.retire")),
      wake: () => keep.pipe(Effect.andThen(forward), retired("wake")),
      alarm: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isBackgroundStopped) {
            yield* state.storage.deleteAlarm();
            return;
          }
          // Re-arm before forwarding, so the heartbeat survives a failed forward or crash.
          yield* heartbeat;
          yield* forward;
        }).pipe(retired("alarm")),
    };
  });
});

/** The retired coordinator class. Its only object is `executor`. */
export class ScheduleCoordinator extends Cloudflare.DurableObject<
  ScheduleCoordinator,
  Effect.Success<Effect.Success<typeof makeRetiredScheduleCoordinator>>
>()("ScheduleCoordinator") {}

export const ScheduleCoordinatorLive = ScheduleCoordinator.make(makeRetiredScheduleCoordinator);

/**
 * Only this class's object dispatches schedules, as the runner `cloud`, exactly as `executor` did.
 * A new class, not a new name, ties the coordinator to this code: a revert removes the class, and
 * with it the object and its alarm, so the old coordinator, whose heartbeat is still armed,
 * resumes alone. It is not exported: only
 * {@link cloudSchedules} reaches its binding.
 */
class PlacedScheduleCoordinator extends Cloudflare.DurableObject<
  PlacedScheduleCoordinator,
  Effect.Success<Effect.Success<typeof makePlacedScheduleCoordinator>>
>()("PlacedScheduleCoordinator") {}

/** The API owns the coordinator and supplies its private service bindings. */
export const PlacedScheduleCoordinatorLive = PlacedScheduleCoordinator.make(
  makePlacedScheduleCoordinator,
);

/**
 * Wakes from the placed fetch handler, the only code that may build this: route changes wake the
 * coordinator promptly, and the minute `schedule-wake` job repairs missing alarms after failures.
 * Code that is not placed (Cron Triggers, workflow steps, Durable Objects) requests that job
 * instead, so it never creates the coordinator where it runs. A route change's wake is best
 * effort: its change is committed, and the minute job wakes the coordinator for it otherwise.
 */
export const cloudSchedules = Effect.gen(function* () {
  const coordinator = yield* PlacedScheduleCoordinator;
  const report = yield* cloudSentry;
  const lifetime = yield* previewLifetime;
  const cleanup = yield* EventCleanup;
  // The namespace binding only exists at runtime, so resolve the stub when the wake runs.
  const wake = (source: WakeSource) =>
    Effect.scoped(report(Effect.suspend(() => coordinator.getByName(coordinatorName).wake()))).pipe(
      Effect.withSpan("schedule.wake", { attributes: { "executor.schedule.wake": source } }),
      Effect.provide(RuntimeContext.phantom),
    );
  const change = wake("change").pipe(
    Effect.catch(() => Effect.logError("Schedule coordinator wake failed")),
  );
  // A request answers once its change is committed, and wakes the coordinator after the
  // response, once per event however many of its writes ask. A busy coordinator answers wakes
  // late: while many new organizations were set up at once, waiting for it held a connection
  // submit for 12 s, and a profile write past its client's minute.
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
    /** Wakes before returning, for work that already runs after its event's response. */
    immediateLayer: Layer.succeed(ScheduleWakeup, change),
    /** The `schedule-wake` job. Its failure fails the job, so a forwarding caller retries. */
    wake: wake("job").pipe(lifetime.background),
  };
});
