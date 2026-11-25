import { Cause, Effect, Option, Schema } from "effect";
import { StartupCode, StartupFailed } from "../contracts/startup.ts";
import { executorAppOwner } from "./owners.ts";

const Diagnostic = Schema.Struct({
  code: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Unknown),
});
const BuiltInBuildFailure = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("VersionBuildFailed"),
    owner: Schema.Literal(executorAppOwner),
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("RuntimeBuildFailed"),
    stage: Schema.Literal("dependencies"),
    message: Schema.String,
  }),
]);
const detailFrom = (error: unknown, depth = 0): string | undefined => {
  if (depth > 3) return undefined;
  const build = Schema.decodeUnknownOption(BuiltInBuildFailure)(error);
  if (Option.isSome(build)) return build.value.message;
  const parsed = Schema.decodeUnknownOption(Diagnostic)(error);
  if (Option.isNone(parsed)) return undefined;
  return detailFrom(parsed.value.cause, depth + 1) ?? detailFrom(parsed.value.reason, depth + 1);
};
const codeFrom = (error: unknown, depth = 0): typeof StartupCode.Type | undefined => {
  if (depth > 3) return undefined;
  const parsed = Schema.decodeUnknownOption(Diagnostic)(error);
  if (Option.isNone(parsed)) return undefined;
  const value = parsed.value;
  if (Schema.is(StartupCode)(value.code)) return value.code;
  return codeFrom(value.cause, depth + 1) ?? codeFrom(value.reason, depth + 1);
};

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
        const detail = detailFrom(error);
        return Effect.fail(
          new StartupFailed({
            stage,
            code: codeFrom(error),
            ...(detail === undefined ? {} : { buildFailure: detail }),
          }),
        );
      }),
    );
