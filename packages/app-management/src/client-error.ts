/** CLI transport and local credential failures never expose credentials. */
import { Schema } from "effect";
/** Sanitized local credential or request failure. */
export class AppClientError extends Schema.TaggedError<AppClientError>()("AppClientError", {
  reason: Schema.Literals(["authentication", "forbidden"]),
}) {}

/** The recovery an Executor API error declares: a next step for people and guidance for agents. */
export const HostRecovery = Schema.Struct({
  action: Schema.String,
  instructions: Schema.String,
});

/**
 * The host answered outside the operation's contract: no answer at all (`network`), a status the
 * contract does not declare (`status`), or a body this CLI cannot read (`response`), which usually
 * means the CLI and the host run different releases. `answer` holds the host's own error code,
 * message and recovery when the body is an Executor API error this CLI does not know yet. Never
 * any other response text, and never a credential.
 */
export class HostRequestFailed extends Schema.TaggedError<HostRequestFailed>()(
  "HostRequestFailed",
  {
    reason: Schema.Literals(["network", "status", "response"]),
    method: Schema.optional(Schema.String),
    /** The request path without its origin or query. */
    path: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Int),
    answer: Schema.optional(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        recovery: Schema.optional(HostRecovery),
      }),
    ),
  },
) {}

/**
 * The CLI refused local source before uploading it: more files or bytes than every Executor host
 * accepts, files that are not UTF-8 text, or a file list that is not a valid app source.
 */
export class SourceRejected extends Schema.TaggedError<SourceRejected>()("SourceRejected", {
  reason: Schema.Literals(["files", "bytes", "binary", "invalid"]),
  /** What the CLI found, stated with the limit it broke. */
  detail: Schema.String,
  /** The files the failure names: the binary files, or the largest ones. */
  paths: Schema.Array(Schema.String),
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
