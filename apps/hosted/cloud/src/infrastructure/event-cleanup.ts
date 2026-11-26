import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Clock, Context, Duration, Effect, Layer, type Option } from "effect";

const cleanupWindow = Duration.seconds(30);

const exportShare = Duration.seconds(5);

export const sqlCancellation = Duration.seconds(10);

const millis = (duration: Duration.Input | undefined) =>
  duration === undefined ? 0 : Duration.toMillis(Duration.fromInputUnsafe(duration));

export class CleanupDeadline {
  private end: number | undefined;

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
    readonly deadline: Effect.Effect<CleanupDeadline>;
  }
>()("executor/cloud/EventCleanup") {}

export const eventCleanup = Layer.effect(
  EventCleanup,
  Effect.map(makeExecutionMemo(Effect.sync(() => new CleanupDeadline())), (deadline) =>
    EventCleanup.of({ deadline }),
  ),
);
