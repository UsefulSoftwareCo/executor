// ---------------------------------------------------------------------------
// Extract the HTTP status from an MCP SDK transport error. The SDK surfaces
// transport failures two ways: a `StreamableHTTPError` subclass carrying a
// numeric `code`, and an SSE POST failure whose message embeds `(HTTP nnn)`.
// Shared by the invoke path (classifies tool-call failures) and the connect
// path (so a 401/403 during the handshake reaches the liveness health check).
// ---------------------------------------------------------------------------

import { Option, Schema } from "effect";

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SsePostErrorCause = Schema.Struct({ message: Schema.String });
const decodeSsePostErrorCause = Schema.decodeUnknownOption(SsePostErrorCause);

// Matches the SDK's SSEClientTransport POST-failure message (sse.js); re-verify
// on SDK bumps. A format drift just yields undefined (generic error, no crash).
const statusFromSsePostError = (cause: unknown): number | undefined =>
  Option.match(decodeSsePostErrorCause(cause), {
    onNone: () => undefined,
    onSome: ({ message }) => {
      const match = /^Error POSTing to endpoint \(HTTP ([1-5][0-9]{2})\):/.exec(message);
      if (!match) return undefined;
      return Number(match[1]);
    },
  });

const statusFromStreamableHttpError = (cause: unknown): number | undefined => {
  // oxlint-disable-next-line executor/no-instanceof-tagged-error -- boundary: MCP SDK exposes transport HTTP failures as this Error subclass; protocol errors can carry the same numeric code
  if (!(cause instanceof StreamableHTTPError)) return undefined;
  const code = cause.code;
  return code !== undefined && code >= 100 && code <= 599 ? code : undefined;
};

export const httpStatusFromCause = (cause: unknown): number | undefined =>
  statusFromStreamableHttpError(cause) ?? statusFromSsePostError(cause);
