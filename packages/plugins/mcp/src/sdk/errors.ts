// MCP plugin tagged errors. API-facing errors carry `HttpApiSchema`
// annotations so they can be `.addError(...)` directly on the API group.

import { Data, Schema } from "effect";

export class McpConnectionError extends Schema.TaggedErrorClass<McpConnectionError>()(
  "McpConnectionError",
  {
    transport: Schema.String,
    message: Schema.String,
    /** HTTP status the handshake observed (e.g. 401 on an auth wall), when the
     *  transport surfaced one. Structural, so the liveness classifier and the
     *  auto-transport fallback never string-match the message. */
    httpStatus: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 400 },
) {}

export class McpToolDiscoveryError extends Schema.TaggedErrorClass<McpToolDiscoveryError>()(
  "McpToolDiscoveryError",
  {
    stage: Schema.Literals(["connect", "list_tools"]),
    message: Schema.String,
    /** HTTP status from the underlying connect failure, when known. */
    httpStatus: Schema.optional(Schema.Number),
  },
  { httpApiStatus: 400 },
) {}

// Internal only: core wraps non-auth failures as ToolInvocationError.cause, so
// this must carry only sanitized invocation metadata. Raw SDK causes can contain
// upstream bodies/challenges and should not leave the invoke catch block.
export class McpInvocationError extends Data.TaggedError("McpInvocationError")<{
  readonly toolName: string;
  readonly message: string;
  readonly status?: number;
  /** The server rejected the call as an unknown tool (protocol error), which
   *  means the persisted catalog has drifted from the server's live tool set. */
  readonly unknownTool?: boolean;
}> {}

export class McpOAuthReauthorizationRequired extends Data.TaggedError(
  "McpOAuthReauthorizationRequired",
)<{
  readonly message: string;
}> {}

export class McpOAuthError extends Schema.TaggedErrorClass<McpOAuthError>()(
  "McpOAuthError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
