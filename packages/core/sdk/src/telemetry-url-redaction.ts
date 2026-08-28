// ---------------------------------------------------------------------------
// URL redaction for exported telemetry — the shared implementation every
// exporter path consumes.
//
// Effect's `HttpMiddleware.tracer` stamps `url.full` and `url.query`
// unconditionally on every `http.server` span, and `HttpClient` does the same
// for outbound `http.client` spans (see `effect/unstable/http`). Those URLs
// routinely carry credentials: `/api/oauth/callback` receives the provider's
// `?code=…&state=…`, query-auth placements put API keys under arbitrary
// parameter names (`?key=…`, `?owner=…` — the NAME is operator-chosen free
// text), fragments carry implicit-grant tokens (`#access_token=…`), and
// userinfo carries basic-auth passwords. Because parameter names are
// arbitrary, no allowlist of "safe" names can exist: EVERY query parameter
// value is dropped, every fragment is dropped, and userinfo is dropped. Only
// scheme, host, and path survive — that is what makes a trace debuggable. The
// parameter NAMES (never values) are reported so a trace still shows that a
// request carried a `code`, without its value; a nameless segment (`?token` —
// indistinguishable from a bare value) is reported as `*`.
//
// URLs also escape the attribute bag: when a request fails, Effect's error
// types embed the raw URL in their `message` ("Transport: … (GET <url>)"),
// which the exporters copy into exception events and the span status. So the
// scrub has a free-text form too, applied to every exported string.
//
// This module is the single source of truth. Consumers:
//   - apps/cloud wraps its OTel span processors (`UrlRedactingSpanProcessor`)
//     around `redactSpanUrlAttributes`/`redactUrlsInText`;
//   - the self-host server and the browser client provide
//     `UrlRedactingOtlpSerializationJson` to their Effect OTLP exporters, so
//     the scrub runs at the serialization seam every span passes through;
//   - apps/cloud's browser-traces forwarder scrubs the decoded OTLP JSON
//     batch with `redactOtlpTraceExport` before forwarding it.
// ---------------------------------------------------------------------------

import { Layer } from "effect";
import * as HttpBody from "effect/unstable/http/HttpBody";
// The deep module: `effect/unstable/observability` re-exports OtlpSerialization
// as a NAMESPACE, and passing the namespace to `Layer.succeed` would key the
// context entry on `undefined`. The service class itself lives here.
import { OtlpSerialization } from "effect/unstable/observability/OtlpSerialization";

/** Span attributes whose value is a whole URL. */
const URL_ATTRIBUTES = ["url.full", "http.url"] as const;
const QUERY_ATTRIBUTE = "url.query";
/** Names of the parameters removed from this span's URL attributes, plus the
 *  markers `userinfo` / `fragment` when those components were dropped and `*`
 *  for a nameless query segment. Non-secret by construction — it is the key
 *  list, never the values. */
export const STRIPPED_QUERY_ATTRIBUTE = "url.query.stripped_keys";

const isUrlAttribute = (name: string): boolean =>
  (URL_ATTRIBUTES as readonly string[]).includes(name);

/** The parameter NAMES of a query string. A segment without `=` has no name —
 *  it may be a bare credential (`?<token>`), so it is reported as `*` rather
 *  than echoed. */
const queryParameterNames = (query: string): readonly string[] => {
  const names = new Set<string>();
  for (const segment of query.split("&")) {
    if (segment === "") continue;
    const separator = segment.indexOf("=");
    names.add(separator === -1 ? "*" : segment.slice(0, separator));
  }
  return Array.from(names).sort();
};

/** A URL reduced to its exportable parts, and what was removed. */
export interface RedactedUrl {
  readonly url: string;
  readonly stripped: readonly string[];
}

/** The URL with userinfo, the entire query string, and the fragment removed.
 *  Scheme, host, and path are untouched. An unparseable value is degraded
 *  textually — truncated at its first `?` or `#`, then shorn of any
 *  `user:password@` prefix — never passed through: if it cannot be parsed it
 *  cannot be proven safe (over-stripping is the safe direction). */
export const redactUrlForTelemetry = (value: string): RedactedUrl => {
  const stripped = new Set<string>();
  if (URL.canParse(value)) {
    const url = new URL(value);
    let changed = false;
    if (url.username !== "" || url.password !== "") {
      url.username = "";
      url.password = "";
      stripped.add("userinfo");
      changed = true;
    }
    if (url.search !== "") {
      for (const name of queryParameterNames(url.search.slice(1))) stripped.add(name);
      url.search = "";
      changed = true;
    }
    if (url.hash !== "") {
      stripped.add("fragment");
      url.hash = "";
      changed = true;
    }
    return changed
      ? { url: url.toString(), stripped: Array.from(stripped).sort() }
      : { url: value, stripped: [] };
  }
  // Malformed fallback. The `#` cut runs before the `@` scan so an `@` inside
  // a fragment is never misread as userinfo.
  const cut = value.search(/[?#]/);
  let head = cut === -1 ? value : value.slice(0, cut);
  if (cut !== -1) {
    const tail = value.slice(cut);
    const fragmentStart = tail.indexOf("#");
    if (fragmentStart !== -1) stripped.add("fragment");
    if (tail.startsWith("?")) {
      const query = fragmentStart === -1 ? tail.slice(1) : tail.slice(1, fragmentStart);
      for (const name of queryParameterNames(query)) stripped.add(name);
    }
  }
  const userinfoEnd = head.lastIndexOf("@");
  if (userinfoEnd !== -1) {
    stripped.add("userinfo");
    head = head.slice(userinfoEnd + 1);
  }
  return head === value
    ? { url: value, stripped: [] }
    : { url: head, stripped: Array.from(stripped).sort() };
};

/** Matches URL-shaped substrings inside free text — error messages, stack
 *  traces, status descriptions. The character class stops at whitespace and
 *  common delimiters so `(GET http://…)` captures only the URL. */
const URL_IN_TEXT = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>()[\]{}]+/g;

/** Free text with every embedded URL redacted (userinfo, query values, and
 *  fragments removed). This is how exception messages and status descriptions
 *  are scrubbed — they carry the URL mid-sentence, not as a whole attribute
 *  value. */
export const redactUrlsInText = (text: string): string =>
  text.replace(URL_IN_TEXT, (match) => redactUrlForTelemetry(match).url);

/** Rewrites the URL-bearing attributes of a span attribute bag in place,
 *  dropping userinfo, every query parameter value, and the fragment. Every
 *  other string attribute is scrubbed as free text, so a URL embedded in an
 *  error-message attribute cannot slip through either. Returns the stripped
 *  parameter names/markers. */
export const redactSpanUrlAttributes = (attributes: Record<string, unknown>): readonly string[] => {
  const stripped = new Set<string>();
  for (const name of URL_ATTRIBUTES) {
    const value = attributes[name];
    if (typeof value !== "string") continue;
    const result = redactUrlForTelemetry(value);
    for (const key of result.stripped) stripped.add(key);
    if (result.url !== value) attributes[name] = result.url;
  }
  const query = attributes[QUERY_ATTRIBUTE];
  if (typeof query === "string" && query !== "") {
    // The raw query attribute never survives; its parameter names are already
    // reported via the stripped-keys list.
    for (const key of queryParameterNames(query)) stripped.add(key);
    attributes[QUERY_ATTRIBUTE] = "";
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value !== "string") continue;
    if (isUrlAttribute(name) || name === QUERY_ATTRIBUTE) continue;
    const redacted = redactUrlsInText(value);
    if (redacted !== value) attributes[name] = redacted;
  }
  return Array.from(stripped).sort();
};

// ---------------------------------------------------------------------------
// OTLP export payload scrub.
// ---------------------------------------------------------------------------

/** Nesting bound for the payload walk. An OTLP batch is a few levels deep;
 *  anything deeper is not a trace batch, and its content is dropped rather
 *  than forwarded unexamined. */
const MAX_SCRUB_DEPTH = 64;

const scrubValue = (value: unknown, depth: number): unknown => {
  if (typeof value === "string") return redactUrlsInText(value);
  if (Array.isArray(value)) {
    return depth >= MAX_SCRUB_DEPTH ? [] : value.map((item) => scrubValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth >= MAX_SCRUB_DEPTH) return {};
    const record = value as Record<string, unknown>;
    // An OTLP KeyValue whose key names a URL attribute gets the URL-aware
    // scrub on its string value (free-text scrubbing alone would miss a
    // malformed URL that the text regex does not match).
    const key = record["key"];
    if (typeof key === "string" && (isUrlAttribute(key) || key === QUERY_ATTRIBUTE)) {
      const inner = record["value"];
      if (inner !== null && typeof inner === "object") {
        const anyValue = inner as Record<string, unknown>;
        const text = anyValue["stringValue"];
        if (typeof text === "string") {
          return {
            ...record,
            value: {
              ...anyValue,
              stringValue: key === QUERY_ATTRIBUTE ? "" : redactUrlForTelemetry(text).url,
            },
          };
        }
      }
    }
    const result: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(record)) {
      result[name] = scrubValue(item, depth + 1);
    }
    return result;
  }
  return value;
};

/** A decoded OTLP trace-export payload (`{ resourceSpans: … }`) with every
 *  string scrubbed of embedded URL credentials and every `url.full` /
 *  `http.url` / `url.query` attribute value redacted. The walk is generic —
 *  every string in the tree passes through the free-text scrub — so a
 *  credential-bearing URL cannot hide in a field the OTLP schema does not
 *  name. */
export const redactOtlpTraceExport = (payload: unknown): unknown => scrubValue(payload, 0);

/** JSON OTLP serialization with the trace payload scrubbed at the
 *  serialization seam — the one chokepoint every exported span passes through
 *  in Effect's OTLP exporter, regardless of which layer created the span.
 *  Drop-in replacement for `OtlpSerialization.layerJson`. Logs and metrics
 *  serialize unchanged. */
export const UrlRedactingOtlpSerializationJson: Layer.Layer<OtlpSerialization> = Layer.succeed(
  OtlpSerialization,
  {
    traces: (spans) => HttpBody.jsonUnsafe(redactOtlpTraceExport(spans)),
    metrics: (metrics) => HttpBody.jsonUnsafe(metrics),
    logs: (logs) => HttpBody.jsonUnsafe(logs),
  },
);
