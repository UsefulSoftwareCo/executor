/**
 * Cloudflare cancels what an event still runs through `waitUntil` 30 seconds after its
 * response. The event's cleanup runs in that window one step after another: Better Auth work
 * the request left running, then the jobs a write starts, then the export of the event's
 * telemetry and error reports. Every step before the export takes its bound from one deadline
 * per event, fixed when the first step starts, so a slow step shortens the later ones and leaves
 * the export its share of the window. A step that may be cut off mid-statement keeps time to
 * cancel it. The export keeps its own request timeouts and retries; this deadline does not bound
 * it, so an export that stalls too can still be cut off with the event.
 */
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Clock, Context, Duration, Effect, Layer, type Option } from "effect";

const cleanupWindow = Duration.seconds(30);

/** Kept for the export, which runs last: OTLP batches and the Sentry flush. */
const exportShare = Duration.seconds(5);

/**
 * Kept by a step that may be cut off mid-statement: the SQL client cancels the statement and
 * drains its connection within 10 seconds, or closes the connection.
 */
export const sqlCancellation = Duration.seconds(10);

const millis = (duration: Duration.Input | undefined) =>
  duration === undefined ? 0 : Duration.toMillis(Duration.fromInputUnsafe(duration));

/** One event's cleanup deadline. */
export class CleanupDeadline {
  private end: number | undefined;

  /**
   * Run one cleanup step until the deadline, keeping `reserve` for work that must follow it,
   * and at most `max`. `None` when the bound elapsed and the step was interrupted, or when less
   * than `need` (or no time) was left, in which case the step does not start.
   */
  within<A, E, R>(
    step: Effect.Effect<A, E, R>,
    options: {
      readonly max?: Duration.Input;
      readonly reserve?: Duration.Input;
      readonly need?: Duration.Input;
    } = {},
  ): Effect.Effect<Option.Option<A>, E, R> {
    return Effect.flatMap(Clock.currentTimeMillis, (now) => {
      this.end ??= now + Duration.toMillis(cleanupWindow) - Duration.toMillis(exportShare);
      const left = this.end - now - millis(options.reserve);
      const bound = options.max === undefined ? left : Math.min(left, millis(options.max));
      return bound <= 0 || bound < millis(options.need)
        ? Effect.succeedNone
        : Effect.timeoutOption(step, Duration.millis(bound));
    });
  }
}

export class EventCleanup extends Context.Service<
  EventCleanup,
  {
    /** The current event's deadline; every step of the same event shares it. */
    readonly deadline: Effect.Effect<CleanupDeadline>;
  }
>()("executor/cloud/EventCleanup") {}

export const eventCleanup = Layer.effect(
  EventCleanup,
  Effect.map(makeExecutionMemo(Effect.sync(() => new CleanupDeadline())), (deadline) =>
    EventCleanup.of({ deadline }),
  ),
);
