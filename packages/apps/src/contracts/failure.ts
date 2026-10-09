/** Failure detail that crosses the runtime boundary to the app's own caller. */
import { Schema } from "effect";

/** Longest failure message carried across the runtime boundary. */
export const maxFailureMessageLength = 2048;
/**
 * `app` for errors thrown by authored code, `storage` for app data failures the host raised, and
 * `service` for an external API the app called through a framework helper.
 */
export const FailureSource = Schema.Literals(["app", "storage", "service"]);
/** The thrown error's name, such as `TypeError`, or the host error's tag. */
export const FailureName = Schema.String.check(Schema.isMaxLength(128));
/** A stable host failure code, such as an app data reason, or the thrown error's own `code`. */
export const FailureCode = Schema.String.check(Schema.isMaxLength(128));
/** Bounded, with the invocation's account secrets replaced. */
export const FailureMessage = Schema.String.check(Schema.isMaxLength(maxFailureMessageLength));

/** Most fields of one thrown error carried across the runtime boundary. */
export const maxFailureFields = 8;
/** Longest text field value carried across the runtime boundary. */
export const maxFailureFieldLength = 256;
/** A field name as the error's code spells it, such as `reason` or `pointer`. */
export const FailureFieldName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/),
);
/** Bounded text with account secrets replaced, a finite number, or a boolean. */
export const FailureFieldValue = Schema.Union([
  Schema.String.check(Schema.isMaxLength(maxFailureFieldLength)),
  Schema.Finite,
  Schema.Boolean,
]);
/**
 * The thrown error's own scalar fields beside its name, code and message, such as the `reason`
 * and `pointer` a spec compiler sets. Nested values, stacks and causes are never carried.
 */
export const FailureFields = Schema.Record(FailureFieldName, FailureFieldValue).check(
  Schema.isMaxProperties(maxFailureFields),
);
export type FailureFields = typeof FailureFields.Type;

/**
 * The error an app's own code raised, or the specific host failure it hit. Stacks and cause
 * values stay private. Builds from before these fields existed send none.
 */
export const FailureDetail = {
  source: Schema.optionalKey(FailureSource),
  errorName: Schema.optionalKey(FailureName),
  code: Schema.optionalKey(FailureCode),
  message: Schema.optionalKey(FailureMessage),
  fields: Schema.optionalKey(FailureFields),
};

/** Longest error message a service stated, as carried across the runtime boundary. */
export const maxUpstreamMessageLength = 1024;
/**
 * The error a service stated in its own response: a JSON-RPC error's code and message, or an
 * OAuth Bearer error code and description. Bounded, with the invocation's account secrets replaced.
 */
export const UpstreamError = Schema.Struct({
  code: Schema.Union([
    Schema.Int,
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ]),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maxUpstreamMessageLength))),
});
export type UpstreamError = typeof UpstreamError.Type;

/** Where a service failed: setting up a session, listing tools, or running one. */
export const FailurePhase = Schema.Literals(["connect", "discover", "call"]);
export type FailurePhase = typeof FailurePhase.Type;
