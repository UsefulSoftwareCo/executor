import { Effect, Schedule } from "effect";
import { providerFailureCode } from "./provider-failure.ts";

/** Persist an immutable object across explicit R2 rate-limit rejections.
 * The caller must retain the same key and complete bytes for every attempt.
 * Stop after three attempts; other errors, defects and cancellation propagate.
 */
export const persistR2Object = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  write.pipe(
    Effect.tapError((error) =>
      providerFailureCode(error) === "r2.10058"
        ? Effect.annotateCurrentSpan("storage.blob.rate_limited", true)
        : Effect.void,
    ),
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("1 second"),
      while: (error) => providerFailureCode(error) === "r2.10058",
    }),
  );
