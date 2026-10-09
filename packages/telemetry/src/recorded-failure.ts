/**
 * Failures as Executor's telemetry records them. Traces and error reports keep an error's text only
 * when Executor wrote it: a tagged error is recorded by its tag and the fixed sentence it declares
 * (see `RecordedMessage`), or by its tag alone when it declares none. Its fields, message, stack and
 * cause are not recorded, so a value an error carries for its caller, an app's text or a service's
 * reply cannot reach telemetry by an error forgetting to declare. The error itself, and what its
 * caller receives, are unchanged.
 */
import { Cause, Predicate } from "effect";
import { recordedMessage } from "@executor-js/utils/recorded-message";

const tagOf = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : undefined;

/** A recorded error: a name and a fixed sentence, and a stack of only those two. */
const recorded = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  error.stack = message === "" ? name : `${name}: ${message}`;
  return error;
};

/**
 * The error a trace or error report records in place of `error`.
 *
 * - A tagged error is named by its tag: a field called `name`, such as a requested skill's or an
 *   app's, replaces the error's own name. Its message is the sentence it declares, or empty. Its
 *   stack is generated here and names no frames: the error's own stack begins with its message,
 *   which can span lines that look like frames. Traces still show where it failed through the
 *   operation's own spans, which Effect appends to a recorded stack.
 * - Any other value that is not an `Error`, such as a plain object Effect would print as JSON, is
 *   recorded as `UnrecognizedFailure` with no text.
 * - An untagged `Error` is a defect or a platform's error: its message and stack come from the
 *   JavaScript engine or a library and are kept, as they are the only diagnosis of an Executor bug.
 *   Its cause is recorded by these same rules.
 */
export const recordedError = (error: unknown): unknown => {
  const tag = tagOf(error);
  if (tag !== undefined) return recorded(tag, recordedMessage(error) ?? "");
  if (!(error instanceof Error)) return recorded("UnrecognizedFailure", "");
  if (error.cause === undefined) return error;
  const copy = new Error(error.message, { cause: recordedError(error.cause) });
  copy.name = error.name;
  if (error.stack !== undefined) copy.stack = error.stack;
  return copy;
};

/**
 * A failure's cause as traces record it: each failure and defect by `recordedError`. Interruptions
 * are unchanged, and each reason keeps its annotations, which locate it.
 */
export const recordedCause = <E>(cause: Cause.Cause<E>): Cause.Cause<unknown> =>
  Cause.fromReasons(
    cause.reasons.flatMap((reason): ReadonlyArray<Cause.Reason<unknown>> => {
      if (Cause.isInterruptReason(reason)) return [reason];
      const replaced = Cause.isFailReason(reason)
        ? Cause.fail(recordedError(reason.error))
        : Cause.die(recordedError(reason.defect));
      return Cause.annotate(replaced, Cause.reasonAnnotations(reason)).reasons;
    }),
  );
