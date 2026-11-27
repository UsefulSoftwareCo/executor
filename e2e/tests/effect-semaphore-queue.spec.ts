import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, Semaphore } from "effect";

const drain = (count: number) =>
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    const started = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      Array.from({ length: count }),
      () => semaphore.withPermits(1)(Effect.yieldNow),
      { concurrency: "unbounded", discard: true },
    );
    return (yield* Clock.currentTimeMillis) - started;
  });

const fastest = (count: number) =>
  Effect.map(
    Effect.forEach([1, 2, 3], () => drain(count)),
    (times) => Math.min(...times),
  );

layer(Layer.empty, { excludeTestServices: true })("Patched Effect semaphore", (it) => {
  it.effect("a queue four times as long takes about four times as long, not sixteen", () =>
    Effect.gen(function* () {
      const short = yield* fastest(4_000);
      const long = yield* fastest(16_000);
      expect(long, `4,000 took ${short} ms and 16,000 took ${long} ms`).toBeLessThan(
        Math.max(short, 20) * 9,
      );
    }),
  );

  it.effect(
    "requests acquire in the order they asked, and one that fits later passes a larger one",
    () =>
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(2);
        const order: Array<string> = [];
        const request = (name: string, permits: number) =>
          Effect.forkChild(
            semaphore.withPermits(permits)(
              Effect.sync(() => order.push(name)).pipe(Effect.andThen(Effect.yieldNow)),
            ),
          );
        const holder = yield* Effect.forkChild(semaphore.withPermits(2)(Effect.never));
        yield* Effect.yieldNow;
        const fibers = [
          yield* request("first", 1),
          yield* request("second", 1),
          yield* request("both", 2),
          yield* request("third", 1),
        ];
        const interrupted = yield* request("interrupted", 1);
        const none = yield* request("none", 0);
        yield* Effect.yieldNow;
        yield* Fiber.join(none);
        expect(order).toEqual(["none"]);
        yield* Fiber.interrupt(interrupted);
        yield* Fiber.interrupt(holder);
        yield* Effect.forEach(fibers, Fiber.join, { discard: true });
        expect(order).toEqual(["none", "first", "second", "third", "both"]);
        expect(yield* semaphore.withPermits(2)(Effect.succeed("free"))).toBe("free");
      }),
  );
});
