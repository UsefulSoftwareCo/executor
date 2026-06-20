// MCP plugin tagged errors. API-facing errors carry `HttpApiSchema`
// annotations so they can be `.addError(...)` directly on the API group.

import { Data, Schema } from "effect";

export class McpConnectionError extends Schema.TaggedErrorClass<McpConnectionError>()(
  "McpConnectionError",
  {
    transport: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class McpToolDiscoveryError extends Schema.TaggedErrorClass<McpToolDiscoveryError>()(
  "McpToolDiscoveryError",
  {
    stage: Schema.Literals(["connect", "list_tools"]),
    message: Schema.String,
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
