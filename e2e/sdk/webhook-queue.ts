/**
 * The start-up webhook source queue of a stage. Provisioning every scenario's organization at once
 * queues their webhook sources together; a scenario that starts behind that queue waits for the
 * whole of it before the sweep reaches its own source. Preparation waits here until the queue it
 * caused has drained, so scenarios start against a sweep that is keeping up.
 */
import { Clock, Effect, Schema } from "effect";
import type { SpanQuery } from "../support/contracts.ts";
import {
  type Delivered,
  hasRoom,
  spanEnd,
  spanStart,
  sweepLimit,
  sweepTaken,
} from "../support/webhook-sweep.ts";
import { fixtureRequest, type FixtureControl } from "./fixtures.ts";

/**
 * The sweep's measured rate on a deployed stage, in sources a second: its passes of 8 served the
 * start-up queue of a deployed run at 2.33 a second (the run's `sdk.webhooks.reconcileSource`
 * spans). The bound below follows from it; a slower sweep fails the bound and says so.
 */
export const measuredRate = 2.33;
/** The most a pass takes: the SDK's `defaultScheduleWorkerOptions.concurrency`. */
export const passLimit = 8;
/** The figures the drain's bound and reads use; a test gives its own. */
export interface DrainPace {
  /** The sweep's rate, in sources a second. */
  readonly rate: number;
  /** Time for a finished pass's span to be delivered and readable. */
  readonly deliveryMs: number;
  /** How often the passes and the queue are read. */
  readonly readSpacingMs: number;
  /** How long the stage's team and member provisioning may take to finish queuing its sources. */
  readonly provisioningMs: number;
  /**
   * The longest an idle sweeper waits before its next pass. When the count catches the pass that
   * takes the last sources already running, no later pass comes until the next wake.
   */
  readonly idleWakeMs: number;
}
export const deployedPace: DrainPace = {
  rate: measuredRate,
  deliveryMs: 30_000,
  readSpacingMs: 5_000,
  // Preparation's infrastructure deadline, which provisioning is part of.
  provisioningMs: 300_000,
  // An idle Cloud coordinator is woken by the `schedule-wake` job on the `* * * * *` Cron Trigger
  // (apps/hosted/cloud/src/main.ts): every 60 s. On 16 November an idle test stage's passes were at
  // most 62.2 s apart (2,816 passes), so 5 s more covers the trigger's late starts.
  idleWakeMs: 65_000,
};

const Queue = Schema.Struct({
  pending: Schema.Int,
  provisioning: Schema.Int,
  at: Schema.Number,
});

/**
 * How long the queue may take: every queued source served at the measured rate, then one more
 * pass (the one that has room) taken and finished, at the latest on the sweeper's next idle wake,
 * then its span delivered.
 */
export const drainBound = (queued: number, pace: DrainPace = deployedPace) =>
  Math.ceil(((queued + 2 * passLimit) / pace.rate) * 1000) + pace.idleWakeMs + pace.deliveryMs;

/** What the drain records in the run's evidence (preparation.json). */
export interface QueueDrain {
  /** How long the stage's team and member provisioning took to finish once the drain began. */
  readonly provisioningMs: number;
  /** Provisioning jobs still to finish at its bound, whose sources may join after the count. */
  readonly provisioningOutstanding?: number;
  /** Sources pending and unleased when provisioning had finished queuing them. */
  readonly queued: number;
  readonly boundMs: number;
  /** From the count to the end of the first pass with room after it; absent if none came. */
  readonly drainMs?: number;
  /** Passes that started after the count, and how many of them had room. */
  readonly passes: number;
  readonly passesWithRoom: number;
  /** The pass that showed the queue drained: its start, what it took and its limit. */
  readonly drainedBy?: {
    readonly startTime: string;
    readonly traceId: string;
    readonly taken: number;
    readonly limit: number;
  };
  /** Sources still pending and unleased when the bound was reached. */
  readonly pendingAtBound?: number;
  /** Reads of the passes that failed, each read again at the next spacing. */
  readonly failedReads?: number;
}

export class QueueNotDrained extends Schema.TaggedError<QueueNotDrained>()("QueueNotDrained", {
  message: Schema.String,
}) {}

/**
 * Wait until the stage's team and member provisioning has finished, since it links each
 * organization's default app accounts and so queues their sources after actor setup answers;
 * then count the queue, and wait until a sweep pass that started after the count has had room.
 * Passes take pending sources first in, first out, so such a pass took the last source queued
 * before the count. Fails at `drainBound(queued)` with the figures. Provisioning that has not
 * finished by its bound is recorded, and the queue is counted then.
 */
/** The stage's queue as the fixture control counts it (`/webhook-queue`). */
export const fixtureQueueCount = (fixtures: typeof FixtureControl.Type) =>
  fixtureRequest(fixtures, "/webhook-queue", {}).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Queue)),
  );

export const drainWebhookQueue = <R0, R1, R2>(input: {
  /** The stage's queue: pending sources, provisioning jobs still to finish, the database's time. */
  readonly count: Effect.Effect<typeof Queue.Type, unknown, R0>;
  /** Delivered sweep passes on this stage since `since` (epoch milliseconds). */
  readonly passes: (since: number) => Effect.Effect<typeof SpanQuery.Type, unknown, R1>;
  readonly record: (drain: QueueDrain) => Effect.Effect<void, never, R2>;
  readonly pace?: DrainPace;
}) =>
  Effect.gen(function* () {
    const pace = input.pace ?? deployedPace;
    const read = input.count;
    const provisioningStarted = yield* Clock.currentTimeMillis;
    let queue = yield* read;
    while (
      queue.provisioning > 0 &&
      (yield* Clock.currentTimeMillis) - provisioningStarted < pace.provisioningMs
    ) {
      yield* Effect.sleep(pace.readSpacingMs);
      queue = yield* read;
    }
    const started = yield* Clock.currentTimeMillis;
    const provisioning = {
      provisioningMs: started - provisioningStarted,
      ...(queue.provisioning > 0 ? { provisioningOutstanding: queue.provisioning } : {}),
    };
    const boundMs = drainBound(queue.pending, pace);
    // Nothing queued: nothing to drain, and no pass need come.
    if (queue.pending === 0) {
      const result: QueueDrain = {
        ...provisioning,
        queued: 0,
        boundMs,
        drainMs: 0,
        passes: 0,
        passesWithRoom: 0,
      };
      yield* input.record(result);
      return result;
    }
    let after: readonly Delivered[] = [];
    let failedReads = 0;
    for (;;) {
      after = (yield* input.passes(queue.at - 60_000).pipe(
        Effect.map((found) => found.data),
        // A read that fails is counted and read again; only the bound ends the wait.
        Effect.orElseSucceed(() => {
          failedReads += 1;
          return after;
        }),
      ))
        .filter(({ span }) => spanStart(span) > queue.at)
        .toSorted((a, b) => spanStart(a.span) - spanStart(b.span));
      const drained = after.find(({ span }) => hasRoom(span));
      const summary = {
        ...provisioning,
        queued: queue.pending,
        boundMs,
        passes: after.length,
        passesWithRoom: after.filter(({ span }) => hasRoom(span)).length,
        ...(failedReads > 0 ? { failedReads } : {}),
      };
      if (drained !== undefined) {
        const result: QueueDrain = {
          ...summary,
          drainMs: spanEnd(drained.span) - queue.at,
          drainedBy: {
            startTime: drained.span.startTime,
            traceId: drained.traceId,
            taken: sweepTaken(drained.span),
            limit: sweepLimit(drained.span),
          },
        };
        yield* input.record(result);
        return result;
      }
      if ((yield* Clock.currentTimeMillis) - started >= boundMs) {
        const left = yield* read.pipe(
          Effect.map(({ pending }) => pending),
          Effect.option,
        );
        const result: QueueDrain = {
          ...summary,
          ...(left._tag === "Some" ? { pendingAtBound: left.value } : {}),
        };
        yield* input.record(result);
        return yield* new QueueNotDrained({
          message: `The webhook source queue did not drain within its bound: ${JSON.stringify(result)}; no sweep pass after the count had room (${pace.rate} sources a second expected).`,
        });
      }
      yield* Effect.sleep(pace.readSpacingMs);
    }
  });
