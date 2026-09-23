/** Author constructors bind typed arguments to an existing mutation without executing it. */
import { Schema } from "effect";
import { Interval, CalendarSchedule, ScheduleTiming } from "../contracts/schedules.ts";
import { JsonValue } from "../contracts/schema.ts";
import { nativeOperation, type Operation, type OperationDeclaration } from "./operations.ts";

/** The app adapter resolves this operation handle to its declared mutation name. */
export interface ScheduleDeclaration<Context = never> {
  readonly operation: OperationDeclaration<"mutation", Context>;
  readonly timing: ScheduleTiming;
  readonly input: JsonValue;
}
const declaration = <Input, Output, Context>(
  timing: ScheduleTiming,
  operation: Operation<Input, Output, "mutation", Context>,
  input: Input,
): ScheduleDeclaration<Context> => {
  const native = nativeOperation(operation);
  if (native === undefined || native.kind !== "mutation")
    throw new Error("A schedule must reference a mutation");
  // Validate author arguments now, but retain the original JSON for the normal invocation decoder.
  Schema.decodeUnknownSync(native.input)(input);
  return { operation, timing, input: Schema.decodeUnknownSync(JsonValue)(input) };
};
/** Run an existing mutation at a fixed interval. Installation enablement belongs to the host. */
export const interval = <Input, Output, Context>(
  duration: Interval,
  operation: Operation<Input, Output, "mutation", Context>,
  input: NoInfer<Input>,
): ScheduleDeclaration<Context> => {
  const value = Schema.decodeUnknownSync(Interval)(duration);
  const milliseconds =
    value.seconds !== undefined
      ? value.seconds * 1000
      : value.minutes !== undefined
        ? value.minutes * 60_000
        : value.hours * 3_600_000;
  return declaration(
    Schema.decodeUnknownSync(ScheduleTiming)({ kind: "interval", milliseconds }),
    operation,
    input,
  );
};
/** Calendar alternative for wall-clock schedules. UTC is the explicit default when timezone is omitted. */
export const cron = <Input, Output, Context>(
  calendar: { readonly expression: string; readonly timezone?: string },
  operation: Operation<Input, Output, "mutation", Context>,
  input: NoInfer<Input>,
): ScheduleDeclaration<Context> =>
  declaration(
    {
      kind: "cron",
      calendar: Schema.decodeUnknownSync(CalendarSchedule)({
        ...calendar,
        timezone: calendar.timezone ?? "UTC",
      }),
    },
    operation,
    input,
  );
