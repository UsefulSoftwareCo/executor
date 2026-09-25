import { Deferred, Effect } from "effect";

/** Keep event resources and telemetry alive until work registered with native waitUntil settles. */
export const dispatchBackground = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  submit: (work: Effect.Effect<A, E, R>) => Effect.Effect<void, never, R>,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const finished = yield* Deferred.make<void>();
      yield* submit(work.pipe(Effect.ensuring(Deferred.succeed(finished, undefined))));
      // Alchemy closes the event scope when its handler returns. Native waitUntil
      // retains the event, but by itself does not retain the Effect exporters.
      yield* Effect.addFinalizer(() => Deferred.await(finished));
    }),
  );
