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
// indistinguishable from a bare value) is reported as `*`. That diagnostic is
// stamped only by the cloud span processor, which holds whole spans; the
// serialization-seam consumers below remove secrets and report nothing.
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
//     the scrub runs at the serialization seam every span and log record
//     passes through;
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
 *  list, never the values. Stamped only by the cloud span processor; the
 *  serialization-seam paths remove secrets without reporting. */
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

/** Applies `redact` to each string element of `values` in place, leaving
 *  non-string elements untouched. OTel attributes permit string[] values, so
 *  an array element carries a URL exactly as a scalar does. In-place mutation
 *  preserves the array's identity, which is how the change reaches a span
 *  whose bag was shallow-copied before redaction. Exported for the cloud
 *  span-processor's event-attribute walk, which redacts the same shapes. */
export const redactStringElements = (
  values: unknown[],
  redact: (value: string) => string,
): void => {
  for (let index = 0; index < values.length; index += 1) {
    const element = values[index];
    if (typeof element === "string") values[index] = redact(element);
  }
};

/** Rewrites the URL-bearing attributes of a span attribute bag in place,
 *  dropping userinfo, every query parameter value, and the fragment. Every
 *  other string attribute is scrubbed as free text, so a URL embedded in an
 *  error-message attribute cannot slip through either. Array values get the
 *  same treatment element by element — OTel attributes permit string[].
 *  Returns the stripped parameter names/markers. */
export const redactSpanUrlAttributes = (attributes: Record<string, unknown>): readonly string[] => {
  const stripped = new Set<string>();
  const redactWholeUrl = (value: string): string => {
    const result = redactUrlForTelemetry(value);
    for (const key of result.stripped) stripped.add(key);
    return result.url;
  };
  for (const name of URL_ATTRIBUTES) {
    const value = attributes[name];
    if (Array.isArray(value)) {
      redactStringElements(value, redactWholeUrl);
      continue;
    }
    if (typeof value !== "string") continue;
    const redacted = redactWholeUrl(value);
    if (redacted !== value) attributes[name] = redacted;
  }
  // The raw query attribute never survives; its parameter names are already
  // reported via the stripped-keys list.
  const dropQuery = (value: string): string => {
    for (const key of queryParameterNames(value)) stripped.add(key);
    return "";
  };
  const query = attributes[QUERY_ATTRIBUTE];
  if (Array.isArray(query)) {
    redactStringElements(query, dropQuery);
  } else if (typeof query === "string" && query !== "") {
    attributes[QUERY_ATTRIBUTE] = dropQuery(query);
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (isUrlAttribute(name) || name === QUERY_ATTRIBUTE) continue;
    if (Array.isArray(value)) {
      redactStringElements(value, redactUrlsInText);
      continue;
    }
    if (typeof value !== "string") continue;
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
    const result: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(record)) {
      result[name] = scrubValue(item, depth + 1);
    }
    // An OTLP KeyValue whose key names a URL attribute additionally gets the
    // URL-aware scrub on its string value (free-text scrubbing alone would
    // miss a malformed URL that the text regex does not match). This runs ON
    // TOP of the generic walk above — never instead of it — so a crafted
    // KeyValue cannot smuggle URL-bearing text through a sibling field.
    const key = record["key"];
    const inner = record["value"];
    if (
      typeof key === "string" &&
      (isUrlAttribute(key) || key === QUERY_ATTRIBUTE) &&
      inner !== null &&
      typeof inner === "object"
    ) {
      const text = (inner as Record<string, unknown>)["stringValue"];
      if (typeof text === "string") {
        result["value"] = {
          ...(result["value"] as Record<string, unknown>),
          stringValue: key === QUERY_ATTRIBUTE ? "" : redactUrlForTelemetry(text).url,
        };
      }
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
 *  name. Removal only: this path adds no `url.query.stripped_keys`
 *  diagnostic (that reporting exists only on the cloud span-processor path). */
export const redactOtlpTraceExport = (payload: unknown): unknown => scrubValue(payload, 0);

/** A decoded OTLP log-export payload (`{ resourceLogs: … }`) with every string
 *  scrubbed of embedded URL credentials. Log records need this as much as
 *  spans do: Effect's `OtlpLogger` exports `Cause.pretty` output (a failure's
 *  error message embeds the raw URL of the request that failed) and every log
 *  annotation verbatim. The walk is the same one traces get, including the
 *  URL-aware KeyValue handling for annotation attributes. */
export const redactOtlpLogExport = (payload: unknown): unknown => scrubValue(payload, 0);

/** JSON OTLP serialization with the trace and log payloads scrubbed at the
 *  serialization seam — the one chokepoint every exported span and log record
 *  passes through in Effect's OTLP exporter, regardless of which layer created
 *  it. Drop-in replacement for `OtlpSerialization.layerJson`. Metrics
 *  serialize unchanged: they are aggregated numbers under fixed metric names,
 *  not request-derived strings. This seam removes secrets only; the
 *  stripped-parameter-names diagnostic is stamped solely by the cloud span
 *  processor, which sees spans as attribute bags rather than serialized
 *  batches. */
export const UrlRedactingOtlpSerializationJson: Layer.Layer<OtlpSerialization> = Layer.succeed(
  OtlpSerialization,
  {
    traces: (spans) => HttpBody.jsonUnsafe(redactOtlpTraceExport(spans)),
    metrics: (metrics) => HttpBody.jsonUnsafe(metrics),
    logs: (logs) => HttpBody.jsonUnsafe(redactOtlpLogExport(logs)),
  },
);
