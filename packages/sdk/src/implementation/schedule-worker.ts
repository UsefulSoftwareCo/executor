/** A Node host owns polling and every in-flight task in its existing Effect scope. */
import { WebhookSourceHost } from "../contracts/webhooks.ts";
import { Effect, Queue, Schedule, Schema, Semaphore } from "effect";
import type { Executor } from "../contracts/executor.ts";
import type { ScheduleAuthority } from "../contracts/scheduler.ts";
import { ScheduleHostReady, ScheduleWorkerOptions } from "../contracts/schedule-worker.ts";

/** Start scoped polling and return a bounded wake signal for committed webhook source changes. */
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
    const sourcesChanged = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
    const tick = executor.scheduler
      .tick({
        runner: config.runner,
        maxCandidates: config.concurrency,
        authorize,
        // Each operation a pass finds is one trace, rooted in a dispatch as a Cloud
        // coordinator's pass is.
        execute: (operation) =>
          pool
            .withPermitsIfAvailable(1)(
              operation.pipe(Effect.withSpan("schedule.dispatch"), Effect.withTracerEnabled(true)),
            )
            .pipe(Effect.asVoid),
      })
      .pipe(
        // A pass runs every second; one that finds nothing to run records nothing.
        Effect.withTracerEnabled(false),
        Effect.catch(() => Effect.logError("Scheduled dispatch failed")),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    yield* Effect.gen(function* () {
      yield* Effect.flatten(ScheduleHostReady);
      return yield* Effect.forever(
        executor[WebhookSourceHost].tick(config.concurrency).pipe(
          Effect.withSpan("schedule.dispatch"),
          Effect.catch(() =>
            Effect.logError("Webhook source dispatch failed").pipe(Effect.as(false)),
          ),
          // A full batch of saved intent runs again at once; otherwise wait for a change.
          Effect.flatMap((more) =>
            more ? Effect.void : Queue.take(sourcesChanged).pipe(Effect.timeoutOption("5 seconds")),
          ),
        ),
      );
    }).pipe(Effect.forkIn(scope));
    yield* Effect.gen(function* () {
      yield* Effect.flatten(ScheduleHostReady);
      yield* executor.scheduler.recover(config.runner);
      yield* tick.pipe(Effect.repeat(Schedule.spaced(config.pollMilliseconds)));
    }).pipe(Effect.forkIn(scope));
    return { wakeWebhookSources: Queue.offer(sourcesChanged, undefined).pipe(Effect.asVoid) };
  });
