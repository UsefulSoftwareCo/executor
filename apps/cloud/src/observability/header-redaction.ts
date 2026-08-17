// ---------------------------------------------------------------------------
// Span header redaction.
//
// Effect's HttpClient/HttpServer tracer records every request and response
// header as a span attribute, masking only the names in
// `Headers.CurrentRedactedNames` (default: authorization, cookie, set-cookie,
// x-api-key). That blocklist can never be right here: executor's whole job is
// calling arbitrary upstream APIs whose credentials ride in provider-specific
// headers (x-goog-api-key, api-key, x-auth-token, ...), and any name missing
// from the list ships a live secret to the trace backend verbatim.
//
// So the override inverts the model: every header is redacted unless its name
// is on the allowlist of structurally safe, diagnostically useful headers.
// The alternative of enumerating known secret-bearing names was rejected: new
// integrations add new credential headers faster than a blocklist can learn
// them, and one miss is a leaked customer credential.
// ---------------------------------------------------------------------------

import { Layer } from "effect";
import { Headers } from "effect/unstable/http";

// Names that never carry credentials and are worth reading on a span while
// debugging: negotiation, caching, routing, and the tracing headers
// themselves. Everything else renders as `<redacted>`.
const SAFE_HEADER_NAMES = [
  "accept",
  "accept-encoding",
  "accept-language",
  "age",
  "cache-control",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "date",
  "etag",
  "expires",
  "host",
  "if-modified-since",
  "if-none-match",
  "last-modified",
  "location",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "referer",
  "retry-after",
  "traceparent",
  "tracestate",
  "transfer-encoding",
  "user-agent",
  "vary",
  "via",
  "x-request-id",
] as const;

// Header names are lowercased at `Headers` construction, and `Headers.redact`
// masks every name a RegExp entry matches. One negative lookahead turns the
// allowlist into "redact everything else".
const redactAllButSafe = new RegExp(`^(?!(?:${SAFE_HEADER_NAMES.join("|")})$)`);

export const SpanHeaderRedactionLive: Layer.Layer<never> = Layer.succeed(
  Headers.CurrentRedactedNames,
  [redactAllButSafe],
);
