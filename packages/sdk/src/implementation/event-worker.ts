import { Effect, Schedule } from "effect";
import { traceFailure } from "@executor-js/telemetry/failed-span";
import type { Executor } from "../contracts/executor.ts";
import { ScheduleHostReady } from "../contracts/schedule-worker.ts";

const batch = 32;

export const deliverEvents = (executor: Executor) =>
  Effect.gen(function* () {
    yield* Effect.flatten(ScheduleHostReady);
    yield* executor.events.deliver({ maxDeliveries: batch }).pipe(
      Effect.repeat({ while: (more) => more }),
      Effect.withTracerEnabled(false),
      traceFailure("events.dispatch"),
      Effect.catch(() => Effect.logError("Event delivery failed")),
      Effect.repeat(Schedule.spaced("2 seconds")),
    );
  });
