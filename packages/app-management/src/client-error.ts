import { Schema } from "effect";
export class AppClientError extends Schema.TaggedError<AppClientError>()("AppClientError", {
  reason: Schema.Literals(["authentication", "forbidden"]),
}) {}

export const HostRecovery = Schema.Struct({
  action: Schema.String,
  instructions: Schema.String,
});

export class HostRequestFailed extends Schema.TaggedError<HostRequestFailed>()(
  "HostRequestFailed",
  {
    reason: Schema.Literals(["network", "status", "response"]),
    method: Schema.optional(Schema.String),
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

export class SourceRejected extends Schema.TaggedError<SourceRejected>()("SourceRejected", {
  reason: Schema.Literals(["files", "bytes", "binary", "invalid"]),
  detail: Schema.String,
  paths: Schema.Array(Schema.String),
}) {}

export class LoginFailed extends Schema.TaggedError<LoginFailed>()("LoginFailed", {
  reason: Schema.Literals([
    "host",
    "unsupported",
    "registration",
    "denied",
    "expired",
    "token",
    "storage",
  ]),
}) {}

export class SignInStateInvalid extends Schema.TaggedError<SignInStateInvalid>()(
  "SignInStateInvalid",
  { file: Schema.String },
) {}

export class ToolsSignInRequired extends Schema.TaggedError<ToolsSignInRequired>()(
  "ToolsSignInRequired",
  { host: Schema.optional(Schema.String) },
) {}

export class ToolCallRefused extends Schema.TaggedError<ToolCallRefused>()("ToolCallRefused", {
  tool: Schema.String,
  reason: Schema.Literals(["tool", "protocol"]),
  code: Schema.optional(Schema.Int),
  message: Schema.String,
}) {}

export class ToolInputInvalid extends Schema.TaggedError<ToolInputInvalid>()("ToolInputInvalid", {
  message: Schema.String,
}) {}

export class WhoamiUnavailable extends Schema.TaggedError<WhoamiUnavailable>()(
  "WhoamiUnavailable",
  { host: Schema.String },
) {}
