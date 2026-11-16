import { Effect, Schedule } from "effect";
import { providerFailureCode } from "./provider-failure.ts";

/** R2's internal error (10001) and temporary unavailability (10043); both ask callers to retry. */
const transient = (error: unknown) => {
  const code = providerFailureCode(error);
  return code === "r2.10001" || code === "r2.10043";
};

/**
 * Read an R2 object, listing or head again after a transient R2 failure. Reads change nothing, so
 * repeating one is safe. Stop after three attempts; other errors, defects and cancellation
 * propagate. A body stream that fails after the read opened is not repeated here.
 */
export const readR2Object = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.tapError((error) =>
      transient(error) ? Effect.annotateCurrentSpan("storage.blob.transient", true) : Effect.void,
    ),
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("100 millis"),
      while: transient,
    }),
  );
