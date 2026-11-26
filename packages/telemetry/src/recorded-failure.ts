import { Cause, Predicate } from "effect";
import { recordedMessage } from "@executor-js/utils/recorded-message";

const tagOf = (error: unknown): string | undefined =>
  Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag) ? error._tag : undefined;

const recorded = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  error.stack = message === "" ? name : `${name}: ${message}`;
  return error;
};

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
