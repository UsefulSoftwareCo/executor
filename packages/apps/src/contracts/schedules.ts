/** Serializable schedules trigger existing mutations; they never introduce another execution path. */
import { Cron, Result, Schema } from "effect";
import { JsonValue } from "./schema.ts";

/** Dispatch coalesces overdue ticks, so sub-minute intervals promise a cadence the runner cannot keep. */
export const minimumIntervalMilliseconds = 60_000;
/** Interval durations use one explicit unit; positive safe integers avoid rounding and overflow. */
const count = Schema.Int.check(Schema.isGreaterThan(0));
const absent = Schema.optionalKey(Schema.Never);
export const Interval = Schema.Union([
  Schema.Struct({ seconds: count, minutes: absent, hours: absent }),
  Schema.Struct({ seconds: absent, minutes: count, hours: absent }),
  Schema.Struct({ seconds: absent, minutes: absent, hours: count }),
]);
export type Interval = typeof Interval.Type;
/** Calendar schedules use five cron fields and an explicit IANA time zone. */
export const CalendarSchedule = Schema.Struct({
  expression: Schema.NonEmptyString,
  timezone: Schema.NonEmptyString,
}).check(
  Schema.makeFilter(
    (value) =>
      value.expression.trim().split(/\s+/).length === 5 &&
      Result.isSuccess(Cron.parse(value.expression, value.timezone)),
  ),
);
/** Validated timing crosses all runtime and persistence boundaries as data. */
export const ScheduleTiming = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("interval"),
    milliseconds: Schema.Int.check(
      Schema.makeFilter((value) => value >= minimumIntervalMilliseconds, {
        message: "Schedule intervals must be at least 60 seconds",
      }),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("cron"), calendar: CalendarSchedule }),
]);
export type ScheduleTiming = typeof ScheduleTiming.Type;
/** A named trigger attached to the mutation it invokes, including schema-validated arguments. */
export const OperationSchedule = Schema.Struct({
  name: Schema.NonEmptyString,
  timing: ScheduleTiming,
  input: JsonValue,
});
export type OperationSchedule = typeof OperationSchedule.Type;
