import { Effect, Schedule } from "effect";
import { providerFailureCode } from "./provider-failure.ts";

export const readNativeWorkflowStatus = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: (error) => error }).pipe(
    Effect.retry({
      times: 2,
      schedule: Schedule.spaced("250 millis"),
      while: (error) => providerFailureCode(error) === "internal",
    }),
  );
