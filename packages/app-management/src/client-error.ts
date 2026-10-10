/** CLI transport and local credential failures never expose credentials or response bodies. */
import { Schema } from "effect";
/** Sanitized local credential or request failure. */
export class AppClientError extends Schema.TaggedError<AppClientError>()("AppClientError", {
  reason: Schema.Literals(["authentication", "forbidden", "request"]),
}) {}

/**
 * Why `executor apps login` did not finish, so the CLI says what happened instead of reporting
 * a missing session. Carries no credential, code or response body.
 */
export class LoginFailed extends Schema.TaggedError<LoginFailed>()("LoginFailed", {
  reason: Schema.Literals([
    /** The host is not a valid origin, or its OAuth discovery could not be read. */
    "host",
    /** The host offers no sign-in with a code. */
    "unsupported",
    /** The host refused to register the CLI as an OAuth client or start a sign-in. */
    "registration",
    /** The person cancelled or denied the request. */
    "denied",
    /** The sign-in code expired before it was approved. */
    "expired",
    /** The host did not issue tokens for an approved sign-in. */
    "token",
    /** The host issued tokens but did not name the signed-in organization. */
    "context",
    /** The OS credential store could not save the session. */
    "storage",
  ]),
}) {}
