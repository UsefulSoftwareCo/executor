/** Host controls, not per-user job quotas. Application timings stay in authored schedules. */
import { Context, Effect, Schema } from "effect";

/** Runner names must identify a single live host/coordinator before recovery is allowed. */
export const ScheduleWorkerOptions = Schema.Struct({
  runner: Schema.NonEmptyString,
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  pollMilliseconds: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type ScheduleWorkerOptions = typeof ScheduleWorkerOptions.Type;
/** Node wake cadence and shared execution pool; hosts may override both at their configuration edge. */
export const defaultScheduleWorkerOptions = { concurrency: 8, pollMilliseconds: 1000 } as const;

/** Real server edges release this gate after routes are listening. Embedded hosts are ready by default. */
export const ScheduleHostReady = Context.Reference<Effect.Effect<void>>("scheduler/HostReady", {
  defaultValue: () => Effect.void,
});
