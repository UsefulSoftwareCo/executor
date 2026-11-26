import { BlobStoreError } from "@executor-js/sdk/core";
import { Effect, Schedule } from "effect";
import { providerFailureCode } from "./provider-failure.ts";
import { transientR2Failure } from "./r2-read.ts";

const rateLimited = (error: unknown) => providerFailureCode(error) === "r2.10058";
const repeatable = (error: unknown) => rateLimited(error) || transientR2Failure(error);

export const persistR2Object = <A, E, R>(write: Effect.Effect<A, E, R>) =>
  write.pipe(
    Effect.tapError((error) =>
      rateLimited(error)
        ? Effect.annotateCurrentSpan("storage.blob.rate_limited", true)
        : transientR2Failure(error)
          ? Effect.annotateCurrentSpan("storage.blob.transient", true)
          : Effect.void,
    ),
    Effect.retry({
      times: 2,
      schedule: Schedule.exponential("1 second"),
      while: repeatable,
    }),
  );

const refusedWrite = (error: unknown) => {
  const code = providerFailureCode(error);
  return code === "r2.10020" || code === "r2.100100" ? { status: 400 } : {};
};

export const writeR2Object = <A, E>(write: Effect.Effect<A, E>) =>
  Effect.suspend(() => {
    let attempts = 0;
    return Effect.suspend(() => {
      attempts += 1;
      return write;
    }).pipe(
      persistR2Object,
      Effect.ensuring(
        Effect.suspend(() => Effect.annotateCurrentSpan("storage.blob.attempts", attempts)),
      ),
    );
  }).pipe(
    Effect.asVoid,
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
    ),
    Effect.mapError((error) => new BlobStoreError({ operation: "put", ...refusedWrite(error) })),
  );
