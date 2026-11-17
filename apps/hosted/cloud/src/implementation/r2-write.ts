import { BlobStoreError } from "@executor-js/sdk/core";
import { Effect, Schedule } from "effect";
import { providerFailureCode } from "./provider-failure.ts";
import { transientR2Failure } from "./r2-read.ts";

/**
 * R2 refuses writes to one key faster than one a second (10058, HTTP 429), and asks callers to
 * retry its internal error (10001) and temporary unavailability (10043)
 * (developers.cloudflare.com/r2/api/error-codes, /r2/platform/limits).
 */
const rateLimited = (error: unknown) => providerFailureCode(error) === "r2.10058";
const repeatable = (error: unknown) => rateLimited(error) || transientR2Failure(error);

/** Persist an immutable object across R2 rate-limit and transient rejections.
 * The caller must retain the same key and complete bytes for every attempt: a put publishes the
 * whole object, so writing identical bytes again leaves the same object, whether or not the
 * refused attempt was stored.
 * Stop after three attempts; other errors, defects and cancellation propagate.
 */
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

/**
 * R2's refusals of a write for what it carries, not for storage's state: an invalid key (10020,
 * invalid characters or over 1,024 bytes) or an object over 5 GiB (100100), both HTTP 400
 * (developers.cloudflare.com/r2/api/error-codes). Writing the same key or bytes again cannot
 * succeed, so the failure keeps R2's status for the caller to tell it from a storage failure.
 */
const refusedWrite = (error: unknown) => {
  const code = providerFailureCode(error);
  return code === "r2.10020" || code === "r2.100100" ? { status: 400 } : {};
};

/** Cloud's blob store write: repeated as `persistR2Object` says, then a `BlobStoreError`. */
export const writeR2Object = <A, E>(write: Effect.Effect<A, E>) =>
  write.pipe(
    persistR2Object,
    Effect.asVoid,
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan({ "storage.blob.failure.code": providerFailureCode(error) }),
    ),
    Effect.mapError((error) => new BlobStoreError({ operation: "put", ...refusedWrite(error) })),
  );
