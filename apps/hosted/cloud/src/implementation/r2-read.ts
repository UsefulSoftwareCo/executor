import { Effect, Schedule } from "effect";
import { providerFailureCode } from "./provider-failure.ts";

export const transientR2Failure = (error: unknown) => {
  const code = providerFailureCode(error);
  return code === "r2.10001" || code === "r2.10043";
};

export const readR2Object = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.tapError((error) =>
      transientR2Failure(error)
        ? Effect.annotateCurrentSpan("storage.blob.transient", true)
        : Effect.void,
    ),
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("100 millis"),
      while: transientR2Failure,
    }),
  );
