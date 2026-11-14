/** A failure that an untraced poll still exports. */
import { Cause, Effect, Predicate } from "effect";

/** Attributes a failure carries for the span that records it. */
type FailureAttributes = Readonly<Record<string, string>>;

const attributesKey: unique symbol = Symbol.for("@executor-js/telemetry/FailureAttributes");

/** The attributes `error` carries for the span that records it; none when it carries none. */
export const failureAttributes = (error: unknown): FailureAttributes =>
  Predicate.hasProperty(error, attributesKey) ? (error[attributesKey] as FailureAttributes) : {};

/**
 * Give `error` attributes for the span that records it, such as which statement failed when the
 * error that reaches the poll no longer says. Attributes it already carries are kept. Use fixed
 * names only: an operation, a table, a failure kind. Never a value a caller, a row or a driver's
 * message supplied. The error's fields and wire encoding are unchanged.
 */
export const withFailureAttributes = <E>(error: E, attributes: FailureAttributes): E => {
  if (typeof error === "object" && error !== null)
    Object.defineProperty(error, attributesKey, {
      value: { ...attributes, ...failureAttributes(error) },
      configurable: true,
    });
  return error;
};

/** The attributes the failure in `cause` carries, if it is not only an interruption. */
const attributesOf = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons.find((reason) => !Cause.isInterruptReason(reason));
  return reason === undefined
    ? {}
    : failureAttributes(Cause.isFailReason(reason) ? reason.error : reason.defect);
};

/**
 * Export a failure of `self` as a span named `name`, even where tracing is off. The span records
 * the failure as any traced operation does, with the attributes its error carries. Inside a traced
 * operation it is a child; inside an untraced poll it is a root. A success, or an interruption
 * alone, records nothing.
 */
export const traceFailure = (name: string) => {
  // The span is located where this is applied, as `Effect.withSpan` locates its own.
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
