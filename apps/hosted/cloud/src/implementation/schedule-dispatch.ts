import { Cause, Effect, Exit, Semaphore } from "effect";

/** Acquire one coordinator's dispatcher for profile maintenance and due schedules. */
export const makeScheduleDispatch = Effect.map(
  Semaphore.make(1),
  (maintenance) =>
    <PE, PR, SE, SR>(
      profiles: Effect.Effect<void, PE, PR>,
      schedules: Effect.Effect<void, SE, SR>,
    ) =>
      Effect.gen(function* () {
        // Maintenance belongs to the coordinator, not each alarm. Due schedules
        // must not queue behind another app's slow profile reconciliation.
        const [profileExit, scheduleExit] = yield* Effect.all(
          [
            maintenance.withPermitsIfAvailable(1)(profiles).pipe(Effect.exit),
            schedules.pipe(Effect.exit),
          ],
          { concurrency: 2 },
        );
        // Keep both operations scoped and retain either failure without cancelling
        // independently admitted work in the other lane.
        if (Exit.isFailure(profileExit) && Exit.isFailure(scheduleExit))
          return yield* Effect.failCause(Cause.combine(profileExit.cause, scheduleExit.cause));
        if (Exit.isFailure(profileExit)) return yield* Effect.failCause(profileExit.cause);
        if (Exit.isFailure(scheduleExit)) return yield* Effect.failCause(scheduleExit.cause);
      }),
);
