/** Author constructors bind typed arguments to an existing mutation without executing it. */
import { Schema } from "effect";
import { Interval, CalendarSchedule, ScheduleTiming } from "../contracts/schedules.ts";
import { JsonValue } from "../contracts/schema.ts";
import type { AccountScope } from "../contracts/app.ts";
import {
  nativeOperation,
  type Operation,
  type OperationDeclaration,
  type WithoutApproval,
} from "./operations.ts";

/**
 * The app adapter resolves this operation handle to its declared mutation name. A `"user"`
 * schedule has one copy per member who enables it, run as them with their linked accounts. An
 * `"app"` schedule is one schedule, enabled by an app manager, run without a caller with the app's
 * accounts only.
 */
export interface ScheduleDeclaration<Context = never, Scope extends AccountScope = AccountScope> {
  readonly scope: Scope;
  readonly operation: OperationDeclaration<"mutation", Context>;
  readonly timing: ScheduleTiming;
  readonly input: JsonValue;
}
const declaration = <Input, Output, Context, Scope extends AccountScope>(
  scope: Scope,
  timing: ScheduleTiming,
  operation: Operation<Input, Output, "mutation", Context>,
  input: Input,
): ScheduleDeclaration<Context, Scope> => {
  const native = nativeOperation(operation);
  if (native === undefined || native.kind !== "mutation")
    throw new Error("A schedule must reference a mutation");
  // App schedules have no person to approve a call; the types refuse an approved mutation too.
  if (scope === "app" && native.approval !== undefined)
    throw new Error("An app schedule must reference a mutation without an approval");
  // Validate author arguments now, but retain the original JSON for the normal invocation decoder.
  Schema.decodeUnknownSync(native.input)(input);
  return { scope, operation, timing, input: Schema.decodeUnknownSync(JsonValue)(input) };
};
const intervalTiming = (duration: Interval) => {
  const value = Schema.decodeUnknownSync(Interval)(duration);
  const milliseconds =
    value.seconds !== undefined
      ? value.seconds * 1000
      : value.minutes !== undefined
        ? value.minutes * 60_000
        : value.hours * 3_600_000;
  return Schema.decodeUnknownSync(ScheduleTiming)({ kind: "interval", milliseconds });
};
const cronTiming = (calendar: {
  readonly expression: string;
  readonly timezone?: string;
}): ScheduleTiming => ({
  kind: "cron",
  calendar: Schema.decodeUnknownSync(CalendarSchedule)({
    ...calendar,
    timezone: calendar.timezone ?? "UTC",
  }),
});

/**
 * Refuses, with a message the type error shows, a mutation whose handler context has the caller's
 * `user`, such as one that declares a context without a type.
 */
type RunsAsApp<Context> = [Context] extends [{ readonly user: unknown }]
  ? {
      readonly 'An app schedule runs without a caller: type the handler\'s context as MutationContext<typeof requirements, "app">, pass it as the third type argument, or declare no parameters and pass no type arguments': never;
    }
  : unknown;

/** Run an existing mutation at a fixed interval, once per member who enables it, as them. */
export const userInterval = <Input, Output, Context>(
  duration: Interval,
  operation: Operation<Input, Output, "mutation", Context>,
  input: NoInfer<Input>,
): ScheduleDeclaration<Context, "user"> =>
  declaration("user", intervalTiming(duration), operation, input);

/**
 * Calendar alternative for wall-clock schedules, once per member who enables it, as them. UTC is the
 * explicit default when timezone is omitted.
 */
export const userCron = <Input, Output, Context>(
  calendar: { readonly expression: string; readonly timezone?: string },
  operation: Operation<Input, Output, "mutation", Context>,
  input: NoInfer<Input>,
): ScheduleDeclaration<Context, "user"> =>
  declaration("user", cronTiming(calendar), operation, input);

/**
 * Run an existing mutation at a fixed interval as the app: one schedule an app manager enables, run
 * without a caller with the app's accounts. The mutation takes a context of the `"app"` scope and
 * declares no approval.
 */
export const appInterval = <Input, Output, Context>(
  duration: Interval,
  operation: Operation<Input, Output, "mutation", Context> & WithoutApproval & RunsAsApp<Context>,
  input: NoInfer<Input>,
): ScheduleDeclaration<Context, "app"> =>
  declaration("app", intervalTiming(duration), operation, input);

/** Calendar alternative to `appInterval`. UTC is the explicit default when timezone is omitted. */
export const appCron = <Input, Output, Context>(
  calendar: { readonly expression: string; readonly timezone?: string },
  operation: Operation<Input, Output, "mutation", Context> & WithoutApproval & RunsAsApp<Context>,
  input: NoInfer<Input>,
): ScheduleDeclaration<Context, "app"> =>
  declaration("app", cronTiming(calendar), operation, input);
