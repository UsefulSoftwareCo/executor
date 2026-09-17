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

// A server that validates a call at the HTTP layer answers with a 4xx whose
// body is a JSON object naming the problem (Stripe's MCP: 422 for a missing
// `stripe_context`). The transport keeps that body on `SdkHttpError.data.text`.
// Read it STRUCTURALLY — parse, then pick a string message field — so a body
// that is not a JSON object (an HTML error page, a proxy banner) contributes
// nothing; only a message the server wrote for the caller comes out.
const JsonErrorBody = Schema.Union([
  Schema.Struct({ message: Schema.String }),
  Schema.Struct({ error: Schema.String }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
]);
const decodeJsonErrorBody = Schema.decodeUnknownOption(JsonErrorBody);
const SdkHttpErrorText = Schema.Struct({ text: Schema.String });
const decodeSdkHttpErrorText = Schema.decodeUnknownOption(SdkHttpErrorText);

const parseJsonSafe = (text: string): unknown => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: classifying an untrusted upstream error body; a parse failure just means "not a JSON body"
  try {
    // oxlint-disable-next-line executor/no-json-parse -- boundary: the parsed value is only structurally decoded for a message field, never used as domain data
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The caller-facing message from a JSON error body the SDK's HTTP error
 *  carries, or `undefined` when there is none. */
export const httpRefusalMessageFromCause = (cause: unknown): string | undefined => {
  const sdk = mcpClientSdkIfLoaded();
  if (sdk === undefined || !sdk.client.SdkHttpError.isInstance(cause)) return undefined;
  const text = Option.getOrUndefined(decodeSdkHttpErrorText(cause.data))?.text;
  if (text === undefined) return undefined;
  const body = Option.getOrUndefined(decodeJsonErrorBody(parseJsonSafe(text)));
  if (body === undefined) return undefined;
  if ("message" in body) return body.message;
  return typeof body.error === "string" ? body.error : body.error.message;
};

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
