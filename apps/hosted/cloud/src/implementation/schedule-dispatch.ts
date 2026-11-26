import { Cause, Effect, Exit, Semaphore } from "effect";

export const makeScheduleDispatch = Effect.gen(function* () {
  const maintenance = yield* Semaphore.make(1);
  let requested = false;
  return {
    request: Effect.sync(() => {
      requested = true;
    }),
    requested: Effect.sync(() => requested),
    run: <PE, PR, SE, SR>(
      sources: Effect.Effect<boolean, PE, PR>,
      schedules: Effect.Effect<void, SE, SR>,
    ) =>
      Effect.gen(function* () {
        const maintain = Effect.gen(function* () {
          let more: boolean;
          do {
            requested = false;
            more = yield* sources;
          } while (more || requested);
        });
        const [sourceExit, scheduleExit] = yield* Effect.all(
          [
            maintenance.withPermitsIfAvailable(1)(maintain).pipe(Effect.exit),
            schedules.pipe(Effect.exit),
          ],
          { concurrency: 2 },
        );
        if (Exit.isFailure(sourceExit) && Exit.isFailure(scheduleExit))
          return yield* Effect.failCause(Cause.combine(sourceExit.cause, scheduleExit.cause));
        if (Exit.isFailure(sourceExit)) return yield* Effect.failCause(sourceExit.cause);
        if (Exit.isFailure(scheduleExit)) return yield* Effect.failCause(scheduleExit.cause);
      }),
  };
});
