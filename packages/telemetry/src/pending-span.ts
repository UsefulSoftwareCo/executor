/** A span ending at an asynchronous milestone, with cancellation owned by its enclosing scope. */
import { Clock, Effect, Exit, type Tracer } from "effect";

/** End exactly once at completion, failure, or scope release. It is not installed as a parent implicitly. */
export const pendingSpan = (name: string, options?: Tracer.SpanOptionsNoTrace) =>
  Effect.gen(function* () {
    const span = yield* Effect.makeSpan(name, options);
    const clock = yield* Clock.Clock;
    let pending = true;
    const close = (exit: Exit.Exit<unknown, unknown>, reached: boolean) =>
      Effect.sync(() => {
        if (!pending) return;
        pending = false;
        span.attribute("executor.milestone.reached", reached);
        span.end(clock.currentTimeNanosUnsafe(), exit);
      });
    yield* Effect.addFinalizer((exit) => close(exit, false));
    return {
      span,
      finish: (exit: Exit.Exit<unknown, unknown>) => close(exit, Exit.isSuccess(exit)),
    };
  });
