import { Effect, Schedule } from "effect";
import { providerFailureCode } from "./provider-failure.ts";

/** Retry an idempotent native status read after a transient internal provider error.
 * Stop after three attempts; missing instances, authorization, decoding and cancellation stay unchanged.
 */
export const readNativeWorkflowStatus = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: (error) => error }).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.spaced("250 millis"),
      while: (error) => providerFailureCode(error) === "internal",
    }),
  );
