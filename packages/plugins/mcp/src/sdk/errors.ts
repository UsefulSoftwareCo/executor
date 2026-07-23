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
    /** The 403 carried an RFC 6750 insufficient_scope challenge (set by the
     *  connection layer when the fetch adapter intercepted one during the
     *  handshake). */
    insufficientScope: Schema.optional(Schema.Boolean),
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
  /** The SDK failure came from the HTTP/SSE transport rather than a JSON-RPC
   *  protocol response. Used only to decide whether a leased session is safe
   *  to return to the idle pool. */
  readonly transportFailure?: boolean;
  /** The server rejected the call as an unknown tool (protocol error), which
   *  means the persisted catalog has drifted from the server's live tool set. */
  readonly unknownTool?: boolean;
  /** A 403 whose body named a scope shortfall (RFC 6750 insufficient_scope /
   *  Google's ACCESS_TOKEN_SCOPE_INSUFFICIENT): re-authenticating the same
   *  grant cannot fix it, so the failure must not be labelled
   *  connection_rejected. */
  readonly insufficientScope?: boolean;
}> {}

export class McpOAuthReauthorizationRequired extends Data.TaggedError(
  "McpOAuthReauthorizationRequired",
)<{
  readonly message: string;
}> {}

/** Thrown by the fetch adapter when a 403 carries an RFC 6750
 *  `error="insufficient_scope"` challenge. Raised BELOW the MCP SDK on
 *  purpose: with an authProvider present the SDK would otherwise consume the
 *  challenge and re-run auth ("upscoping"), which our static-token provider
 *  can only answer by demanding reauthorization — the exact loop the
 *  oauth_scope_insufficient classification exists to break. */
export class McpInsufficientScopeError extends Data.TaggedError("McpInsufficientScopeError")<{
  readonly message: string;
}> {}

export class McpOAuthError extends Schema.TaggedErrorClass<McpOAuthError>()(
  "McpOAuthError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
