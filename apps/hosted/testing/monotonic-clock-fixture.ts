/**
 * Test host only: advances Effect's monotonic clock so a scenario can age a kept search order
 * while a read waits. Wall time, sleeps, and deadlines based on them use the live clock.
 * Production entry points never provide it.
 */
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const path = "/api/devtools/monotonic-clock";
const Advance = Schema.Struct({ advanceMillis: Schema.Int.check(Schema.isGreaterThan(0)) });

export const monotonicClockFixture = Effect.gen(function* () {
  const live = yield* Clock.Clock;
  let offset = 0n;
  const nanos = () => live.monotonicTimeNanosUnsafe() + offset;
  const clock = Layer.succeed(Clock.Clock, {
    currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
    currentTimeMillis: live.currentTimeMillis,
    currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
    currentTimeNanos: live.currentTimeNanos,
    sleep: (duration) => live.sleep(duration),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
  });
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "POST",
      path,
      Effect.gen(function* () {
        const { advanceMillis } = yield* HttpServerRequest.schemaBodyJson(Advance);
        offset += BigInt(advanceMillis) * 1_000_000n;
        return HttpServerResponse.jsonUnsafe({ advanced: true });
      }).pipe(Effect.orDie),
    ),
    HttpRouter.add(
      "DELETE",
      path,
      Effect.sync(() => {
        offset = 0n;
        return HttpServerResponse.jsonUnsafe({ reset: true });
      }),
    ),
  );
  return { clock, routes };
});
