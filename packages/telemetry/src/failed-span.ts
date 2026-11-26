import { Cause, Effect, Predicate } from "effect";

type FailureAttributes = Readonly<Record<string, string>>;

const attributesKey: unique symbol = Symbol.for("@executor-js/telemetry/FailureAttributes");

export const failureAttributes = (error: unknown): FailureAttributes =>
  Predicate.hasProperty(error, attributesKey) ? (error[attributesKey] as FailureAttributes) : {};

export const withFailureAttributes = <E>(error: E, attributes: FailureAttributes): E => {
  if (typeof error === "object" && error !== null)
    Object.defineProperty(error, attributesKey, {
      value: { ...attributes, ...failureAttributes(error) },
      configurable: true,
    });
  return error;
};

const attributesOf = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons.find((reason) => !Cause.isInterruptReason(reason));
  return reason === undefined
    ? {}
    : failureAttributes(Cause.isFailReason(reason) ? reason.error : reason.defect);
};

export const traceFailure = (name: string) => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 2;
  const site = new Error();
  Error.stackTraceLimit = limit;
  const captureStackTrace = () => site.stack?.split("\n")[2]?.trim();
  return <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.failCause(cause).pipe(
              Effect.withSpan(name, { attributes: attributesOf(cause) }, { captureStackTrace }),
              Effect.withTracerEnabled(true),
            ),
      ),
    );
};
