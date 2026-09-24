/** A Node host owns polling and every in-flight task in its existing Effect scope. */
import { ProfileHost } from "../contracts/profiles.ts";
import { Effect, Queue, Schedule, Schema, Semaphore } from "effect";
import type { Executor } from "../contracts/executor.ts";
import type { ScheduleAuthority } from "../contracts/scheduler.ts";
import { ScheduleHostReady, ScheduleWorkerOptions } from "../contracts/schedule-worker.ts";

/** Start scoped polling and return a bounded wake signal for committed profile changes. */
export const startScheduleWorker = (
  executor: Executor,
  authorize: (target: ScheduleAuthority) => Effect.Effect<void, Error>,
  options: ScheduleWorkerOptions,
) =>
  Effect.gen(function* () {
    const config = yield* Schema.decodeUnknownEffect(ScheduleWorkerOptions)(options);
    const scope = yield* Effect.scope;
    const pool = yield* Semaphore.make(config.concurrency);
    // Coalesce writes while reconciliation runs. A queued wake survives until
    // the current pass completes; the same worker owns every pass.
    const profilesChanged = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
    const tick = executor.scheduler
      .tick({
        runner: config.runner,
        maxCandidates: config.concurrency,
        authorize,
        execute: (operation) => pool.withPermitsIfAvailable(1)(operation).pipe(Effect.asVoid),
      })
      .pipe(
        Effect.catch(() => Effect.logError("Scheduled dispatch failed")),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    yield* Effect.gen(function* () {
      yield* Effect.flatten(ScheduleHostReady);
      yield* Effect.forever(
        executor[ProfileHost].tick(config.concurrency).pipe(
          Effect.catch(() => Effect.logError("Profile setup dispatch failed")),
          Effect.andThen(Queue.take(profilesChanged).pipe(Effect.timeoutOption("5 seconds"))),
        ),
      );
    }).pipe(Effect.forkIn(scope));
    yield* Effect.gen(function* () {
      yield* Effect.flatten(ScheduleHostReady);
      yield* executor.scheduler.recover(config.runner);
      yield* tick.pipe(Effect.repeat(Schedule.spaced(config.pollMilliseconds)));
    }).pipe(Effect.forkIn(scope));
    return { wakeProfiles: Queue.offer(profilesChanged, undefined).pipe(Effect.asVoid) };
  });
