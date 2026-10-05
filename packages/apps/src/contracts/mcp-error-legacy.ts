import { Schema } from "effect";

/** Safe protocol/transport failure; no raw upstream payloads or credentials. */
export class McpError extends Schema.TaggedError<McpError>()("McpError", {
  phase: Schema.Literals(["connect", "discover", "call", "schema", "transport"]),
  reason: Schema.Literals([
    "request",
    "unauthorized",
    "invalid_response",
    "timeout",
    "invalid_input",
  ]),
  status: Schema.optional(Schema.Number),
}) {}
