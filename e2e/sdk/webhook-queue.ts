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

export const measuredRate = 2.33;
export const passLimit = 8;
export interface DrainPace {
  readonly rate: number;
  readonly deliveryMs: number;
  readonly readSpacingMs: number;
  readonly provisioningMs: number;
  readonly idleWakeMs: number;
}
export const deployedPace: DrainPace = {
  rate: measuredRate,
  deliveryMs: 30_000,
  readSpacingMs: 5_000,
  provisioningMs: 300_000,
  idleWakeMs: 65_000,
};

const Queue = Schema.Struct({
  pending: Schema.Int,
  provisioning: Schema.Int,
  at: Schema.Number,
});

export const drainBound = (queued: number, pace: DrainPace = deployedPace) =>
  Math.ceil(((queued + 2 * passLimit) / pace.rate) * 1000) + pace.idleWakeMs + pace.deliveryMs;

export interface QueueDrain {
  readonly provisioningMs: number;
  readonly provisioningOutstanding?: number;
  readonly queued: number;
  readonly boundMs: number;
  readonly drainMs?: number;
  readonly passes: number;
  readonly passesWithRoom: number;
  readonly drainedBy?: {
    readonly startTime: string;
    readonly traceId: string;
    readonly taken: number;
    readonly limit: number;
  };
  readonly pendingAtBound?: number;
  readonly failedReads?: number;
}

export class QueueNotDrained extends Schema.TaggedError<QueueNotDrained>()("QueueNotDrained", {
  message: Schema.String,
}) {}

export const fixtureQueueCount = (fixtures: typeof FixtureControl.Type) =>
  fixtureRequest(fixtures, "/webhook-queue", {}).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Queue)),
  );

export const drainWebhookQueue = <R0, R1, R2>(input: {
  readonly count: Effect.Effect<typeof Queue.Type, unknown, R0>;
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
