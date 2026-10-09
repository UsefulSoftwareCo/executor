import { Schema } from "effect";

/** Longest agent guidance an API error's recovery carries. */
export const maxApiErrorInstructionsLength = 4096;

/** Bounded recovery a declared API error published for its caller: a short next step and agent guidance. */
export const ApiErrorRecovery = Schema.Struct({
  action: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  instructions: Schema.NonEmptyString.check(Schema.isMaxLength(maxApiErrorInstructionsLength)),
});
/** Recovery copied from an error response body; extra keys are dropped on decode. */
export type ApiErrorRecovery = typeof ApiErrorRecovery.Type;

/** Longest message an API error response carries. */
export const maxApiErrorMessageLength = 4096;

/** Bounded public fields from a response matching its declared API error schema. */
export const ApiErrorResponse = Schema.Struct({
  code: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
  message: Schema.NonEmptyString.check(Schema.isMaxLength(maxApiErrorMessageLength)),
  recovery: Schema.optionalKey(ApiErrorRecovery),
});
/** Safe projection of a response matching a declared API error schema. */
export type ApiErrorResponse = typeof ApiErrorResponse.Type;

/** A validated OpenAPI failure with its declared message or static schema explanation. */
export class OpenapiResponseError extends Schema.TaggedError<OpenapiResponseError>()(
  "OpenapiResponseError",
  ApiErrorResponse.fields,
) {}

/** Error response reads have independent byte and time bounds, including chunked bodies. */
export const OpenapiErrorLimits = Schema.Struct({
  maxBodyBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  readTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
/** Stop reading on overflow or timeout and keep the generic HTTP failure. */
export const defaultOpenapiErrorLimits = OpenapiErrorLimits.make({
  maxBodyBytes: 65_536,
  readTimeoutMs: 2_000,
});
