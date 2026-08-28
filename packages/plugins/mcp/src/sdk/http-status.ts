// ---------------------------------------------------------------------------
// Extract the HTTP status from an MCP SDK transport error. The SDK surfaces
// transport failures two ways: an `SdkHttpError` carrying a numeric `status`,
// and an `SseError` carrying a numeric `code`. The SSE transport also retains
// its historic POST-failure message for errors created below EventSource.
// Shared by the invoke path (classifies tool-call failures) and the connect
// path (so a 401/403 during the handshake reaches the liveness health check).
// ---------------------------------------------------------------------------

import { Option, Schema } from "effect";

import { insufficientScopeFromEmbeddedJson } from "@executor-js/sdk/core";
// The SDK error classes are reached through the lazy loader: any error of
// those classes was constructed by the loaded client module, so "not loaded"
// soundly classifies the cause as not-an-SDK-error (see client-module.ts).
import { mcpClientSdkIfLoaded } from "./client-module";

const SsePostErrorCause = Schema.Struct({ message: Schema.String });
const decodeSsePostErrorCause = Schema.decodeUnknownOption(SsePostErrorCause);
const NumericHttpCodeCause = Schema.Struct({ code: Schema.Number });
const decodeNumericHttpCodeCause = Schema.decodeUnknownOption(NumericHttpCodeCause);

// V2 still constructs this exact message in SSEClientTransport._send. A format
// drift just yields undefined (generic error, no crash).
const statusFromSsePostError = (cause: unknown): number | undefined =>
  Option.match(decodeSsePostErrorCause(cause), {
    onNone: () => undefined,
    onSome: ({ message }) => {
      const match = /^Error POSTing to endpoint \(HTTP ([1-5][0-9]{2})\):/.exec(message);
      if (!match) return undefined;
      return Number(match[1]);
    },
  });

const statusFromTypedTransportError = (cause: unknown): number | undefined => {
  const sdk = mcpClientSdkIfLoaded();
  if (sdk === undefined) return undefined;
  if (sdk.client.SdkHttpError.isInstance(cause)) return cause.status;
  if (sdk.client.SseError.isInstance(cause)) {
    const code = cause.code;
    return code !== undefined && code >= 100 && code <= 599 ? code : undefined;
  }
  return undefined;
};

const statusFromNumericHttpCode = (cause: unknown): number | undefined =>
  Option.match(decodeNumericHttpCodeCause(cause), {
    onNone: () => undefined,
    onSome: ({ code }) => (code >= 100 && code <= 599 ? code : undefined),
  });

export const httpStatusFromCause = (cause: unknown): number | undefined =>
  statusFromTypedTransportError(cause) ?? statusFromSsePostError(cause);

/** Connection handshakes may receive the SDK's SSE error, whose numeric code
 * is an HTTP status. Keep this connection-only: JSON-RPC invocation errors
 * also have numeric `code` fields which are not HTTP statuses. */
export const connectionHttpStatusFromCause = (cause: unknown): number | undefined =>
  httpStatusFromCause(cause) ?? statusFromNumericHttpCode(cause);

/** The SDK uses code -1 when Streamable HTTP reached the endpoint but its
 * response did not implement the protocol (for example an unexpected content
 * type). This is transport incompatibility, not a network outage. */
export const isStreamableHttpProtocolError = (cause: unknown): boolean => {
  const sdk = mcpClientSdkIfLoaded();
  return (
    sdk !== undefined &&
    sdk.client.SdkError.isInstance(cause) &&
    cause.code === sdk.client.SdkErrorCode.ClientHttpUnexpectedContent
  );
};

// The SDK embeds the upstream response text in the transport error message
// ("Error POSTing to endpoint: <body>"), which is the only place a 403's body
// survives for connections without an authProvider. For OAuth connections the
// StreamableHTTP transport consumes the insufficient_scope challenge itself.
// V2 throws `InsufficientScopeError` when configured not to reauthorize; after
// exhausting its step-up retries it throws `SdkHttpError` with the exact fixed
// message matched below (verified against the installed v2 transport source).
// Both paths mean the same thing: the grant does not cover the operation, and
// re-running the identical flow cannot help. Strict matching
// (exact serialized field forms via the shared core detector, or the SDK's
// exact step-up message) — a miss stays on the generic auth path.
const SDK_STEP_UP_EXHAUSTED_RE =
  /^Server returned 403 insufficient_scope after step-up re-authorization \(retry limit \d+ reached\)$/;

export const insufficientScopeFromCause = (cause: unknown): boolean =>
  (mcpClientSdkIfLoaded()?.client.InsufficientScopeError.isInstance(cause) ?? false) ||
  Option.match(decodeSsePostErrorCause(cause), {
    onNone: () => false,
    onSome: ({ message }) =>
      insufficientScopeFromEmbeddedJson(message) || SDK_STEP_UP_EXHAUSTED_RE.test(message),
  });
