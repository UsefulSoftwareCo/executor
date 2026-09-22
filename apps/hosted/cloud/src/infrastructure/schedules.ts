import { cloudAnalytics, recordBackgroundUsage } from "../implementation/product-analytics.ts";
import { ScheduleObservation } from "@executor-js/sdk/scheduling";
import { previewLifetime } from "./test-stage-expiry.ts";
import { ProfileHost } from "@executor-js/sdk/core";
import { scheduleRecoveryMilliseconds } from "../contracts/schedules.ts";
/** Native alarms wake one coordinator; authoritative schedule/run state remains in Postgres. */
import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { CloudflareHyperdrive } from "@alchemy.run/better-auth/CloudflareHyperdrive";
import { Config, Clock, Effect, Layer, Schema, Semaphore } from "effect";
import {
  HostedExecutor,
  ScheduledAuthority,
  ScheduleWakeup,
  ExecutionAdmission,
} from "@executor-js/hosted-server";
import { defaultScheduleWorkerOptions } from "@executor-js/sdk/scheduling";
import { cloudExecutor } from "./executor.ts";
import { AppDataSupervisor, AppDataSupervisorLive } from "./app-data.ts";
import { DatabaseConnection } from "./database.ts";
import { cloudTelemetry } from "./telemetry.ts";
import { billingLive } from "../implementation/billing.ts";
import { BillingMeter } from "../contracts/billing-meter.ts";

const makeScheduleCoordinator = Effect.gen(function* () {
  const analytics = yield* cloudAnalytics;
  const resources = yield* cloudExecutor(yield* AppDataSupervisor);
  const billing = yield* billingLive;
  const meter = yield* BillingMeter.pipe(Effect.provide(billing));
  const concurrency = yield* Config.Number("EXECUTOR_SCHEDULE_CONCURRENCY").pipe(
    Config.withDefault(defaultScheduleWorkerOptions.concurrency),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Int.check(Schema.isGreaterThan(0)))),
    Effect.orDie,
  );
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const lifetime = yield* previewLifetime;
    const pool = yield* Semaphore.make(concurrency);
    const lifecycle = yield* Semaphore.make(1);
    const alarms = yield* Semaphore.make(1);
    let initialized = false;
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(resources),
        Effect.provideService(ExecutionAdmission, meter.consume),
      );
    const arm = alarms.withPermits(1)(
      provide(
        Effect.gen(function* () {
          const executor = yield* Effect.flatten(HostedExecutor);
          const next = yield* executor.scheduler.nextWake;
          if (next === null) yield* state.storage.deleteAlarm();
          else
            yield* state.storage.setAlarm(
              Math.max(
                next.getTime(),
                (yield* Clock.currentTimeMillis) + defaultScheduleWorkerOptions.pollMilliseconds,
              ),
            );
        }),
      ),
    );
    const run = Effect.scoped(
      analytics.wrap(
        provide(
          Effect.gen(function* () {
            const executor = yield* Effect.flatten(HostedExecutor);
            const authorize = yield* ScheduledAuthority;
            yield* lifecycle.withPermits(1)(
              Effect.gen(function* () {
                if (!initialized) {
                  yield* executor.scheduler.recover("cloud");
                  initialized = true;
                }
              }),
            );
            // Alarm callbacks own this work through waitUntil; new wakes can discover other due apps meanwhile.
            yield* executor[ProfileHost].tick(concurrency);
            yield* executor.scheduler.tick({
              runner: "cloud",
              maxCandidates: concurrency,
              authorize,
              execute: (operation) => pool.withPermitsIfAvailable(1)(operation).pipe(Effect.asVoid),
            });
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
      Effect.catch(() => Effect.logError("Cloud scheduled dispatch failed")),
    );
    return {
      wake: () =>
        alarms.withPermits(1)(
          Effect.gen(function* () {
            if (yield* lifetime.isExpired) {
              yield* state.storage.deleteAlarm();
              return;
            }
            yield* state.storage.setAlarm(
              (yield* Clock.currentTimeMillis) + defaultScheduleWorkerOptions.pollMilliseconds,
            );
          }),
        ),
      alarm: () =>
        Effect.gen(function* () {
          if (yield* lifetime.isExpired) {
            yield* state.storage.deleteAlarm();
            return;
          }
          // A durable recovery wake remains if storage is temporarily unavailable or this event crashes.
          yield* alarms.withPermits(1)(
            Effect.gen(function* () {
              yield* state.storage.setAlarm(
                (yield* Clock.currentTimeMillis) + scheduleRecoveryMilliseconds,
              );
            }),
          );
          yield* state.waitUntil(run);
          // Keep considering unclaimed due work while admitted runs are waiting on external I/O.
          yield* Effect.scoped(arm).pipe(
            lifetime.background,
            Effect.catch(() => Effect.logError("Schedule alarm planning failed")),
          );
        }),
    };
  });
}).pipe(
  Effect.provide(
    Layer.mergeAll(AppDataSupervisorLive, CloudflareHyperdrive(DatabaseConnection), cloudTelemetry),
  ),
  Effect.orDie,
);

/** Only this object owns the cloud runner identity; restart recovery never claims another live runner. */
export class ScheduleCoordinator extends Cloudflare.DurableObject<
  ScheduleCoordinator,
  Effect.Success<Effect.Success<typeof makeScheduleCoordinator>>
>()("ScheduleCoordinator") {}

/** The API owns the coordinator and supplies its private service bindings. */
export const ScheduleCoordinatorLive = ScheduleCoordinator.make(makeScheduleCoordinator);

/** Route changes wake the coordinator promptly; a native cron heartbeat repairs missing alarms after failures. */
export const cloudSchedules = Effect.gen(function* () {
  const coordinator = yield* ScheduleCoordinator;
  const lifetime = yield* previewLifetime;
  // The namespace binding only exists at runtime, so resolve the stub when the wake runs.
  const wake = Effect.suspend(() => coordinator.getByName("executor").wake()).pipe(
    Effect.catch(() => Effect.logError("Schedule coordinator wake failed")),
    Effect.provide(RuntimeContext.phantom),
  );
  yield* Cloudflare.Workers.cron("* * * * *", () => wake.pipe(lifetime.background));
  return Layer.succeed(ScheduleWakeup, wake);
});
