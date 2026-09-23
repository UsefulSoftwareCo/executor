/** Driver operations select a recorded window on one shared wall clock. */
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { Target } from "./platform.ts";

const Milliseconds = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const Window = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["browser", "terminal"]),
  title: Schema.String,
  file: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+\.mp4$/)),
  startedAtMs: Milliseconds,
});
const Activity = Schema.Struct({
  window: Schema.String,
  label: Schema.String,
  startedAtMs: Milliseconds,
  endedAtMs: Milliseconds,
});
/** Persisted capture origins and ordered calls; completion never creates another focus event. */
export const RecordingTimeline = Schema.Struct({
  windows: Schema.Array(Window),
  activities: Schema.Array(Activity),
});
/** A driver's handle records intent without exposing command arguments or environment values. */
export interface RecordingWindow {
  readonly use: <A, E, R>(
    label: string,
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

const make = Effect.gen(function* () {
  const { recordingPaceMs } = yield* Target;
  const windows: (typeof Window.Type)[] = [];
  type PendingActivity = {
    window: string;
    label: string;
    startedAtMs: number;
    endedAtMs: number | null;
  };
  const activities: PendingActivity[] = [];
  return {
    open: (source: Omit<typeof Window.Type, "id">) =>
      Effect.gen(function* () {
        const openedAtMs = yield* Clock.currentTimeMillis;
        if (windows.some((window) => window.file === source.file))
          throw new Error("Each recorded window needs its own media file");
        const id = `window-${windows.length}`;
        windows.push({ ...source, id });
        // Opening was called before the native driver finished creating the window.
        activities.push({
          window: id,
          label: `Open ${source.title}`,
          startedAtMs: source.startedAtMs,
          endedAtMs: openedAtMs,
        });
        return {
          use: <A, E, R>(label: string, operation: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              const startedAtMs = yield* Clock.currentTimeMillis;
              const activity: PendingActivity = { window: id, label, startedAtMs, endedAtMs: null };
              activities.push(activity);
              return yield* operation.pipe(
                // Keep the result visible before the next browser or terminal operation.
                // Failures and cancellation do not wait; the scope still saves evidence.
                Effect.tap(() =>
                  recordingPaceMs === 0 ? Effect.void : Effect.sleep(recordingPaceMs * 2),
                ),
                Effect.onExit(() =>
                  Effect.gen(function* () {
                    activity.endedAtMs = yield* Clock.currentTimeMillis;
                  }),
                ),
              );
            }),
        } satisfies RecordingWindow;
      }),
    snapshot: Effect.sync(() => ({
      windows: [...windows],
      activities: activities
        .toSorted((a, b) => a.startedAtMs - b.startedAtMs)
        .map((activity) => {
          if (activity.endedAtMs === null)
            throw new Error("Cannot export a recording while a driver call is active");
          return { ...activity, endedAtMs: activity.endedAtMs };
        }),
    })).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordingTimeline)), Effect.orDie),
  };
});
/** Case-scoped recording coordinator, shared by browser and terminal adapters. */
export class RecordingFocus extends Context.Service<RecordingFocus, Effect.Success<typeof make>>()(
  "e2e/RecordingFocus",
) {
  static readonly layer = Layer.effect(RecordingFocus, make);
}
