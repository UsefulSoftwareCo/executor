import { Deferred, Effect } from "effect";

export const dispatchBackground = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  submit: (work: Effect.Effect<A, E, R>) => Effect.Effect<void, never, R>,
) =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const finished = yield* Deferred.make<void>();
      yield* submit(work.pipe(Effect.ensuring(Deferred.succeed(finished, undefined))));
      yield* Effect.addFinalizer(() => Deferred.await(finished));
    }),
  );
