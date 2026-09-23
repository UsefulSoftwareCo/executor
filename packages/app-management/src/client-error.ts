/** CLI transport and local credential failures never expose credentials or response bodies. */
import { Schema } from "effect";
/** Sanitized local credential or request failure. */
export class AppClientError extends Schema.TaggedError<AppClientError>()("AppClientError", {
  reason: Schema.Literals(["authentication", "forbidden", "request"]),
}) {}
