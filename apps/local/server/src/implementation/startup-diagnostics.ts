/** Keep startup phase and known system codes without serializing paths, configuration or causes. */
import { Cause, Effect, Option, Schema } from "effect";
import { StartupCode, StartupFailed } from "../contracts/startup.ts";

const Diagnostic = Schema.Struct({
  code: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Unknown),
});
const codeFrom = (error: unknown, depth = 0): typeof StartupCode.Type | undefined => {
  if (depth > 3) return undefined;
  const parsed = Schema.decodeUnknownOption(Diagnostic)(error);
  if (Option.isNone(parsed)) return undefined;
  const value = parsed.value;
  if (Schema.is(StartupCode)(value.code)) return value.code;
  return codeFrom(value.cause, depth + 1) ?? codeFrom(value.reason, depth + 1);
};

/** Translate at the resource boundary; preserve an already classified inner phase and cancellation. */
export const startupPhase =
  (stage: StartupFailed["stage"]) =>
  <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      Effect.catchCause((cause): Effect.Effect<never, StartupFailed> => {
        if (Cause.hasInterruptsOnly(cause))
          return Effect.failCause(
            Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)),
          );
        const error = Cause.squash(cause);
        if (Schema.is(StartupFailed)(error)) return Effect.fail(error);
        return Effect.fail(new StartupFailed({ stage, code: codeFrom(error) }));
      }),
    );
