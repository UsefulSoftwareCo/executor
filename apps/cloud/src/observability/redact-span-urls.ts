// ---------------------------------------------------------------------------
// URL redaction for exported spans.
//
// Effect's `HttpMiddleware.tracer` stamps `url.full` and `url.query`
// unconditionally on every `http.server` span, and `HttpClient` does the same
// for outbound `http.client` spans (see `effect/unstable/http`). Outbound
// request URLs routinely carry credentials — `/api/oauth/callback` receives
// the provider's `?code=…&state=…`, and integration endpoints accept API keys
// as arbitrary query parameters (a GraphQL integration may authenticate with
// `?key=…`). Credential parameter names cannot be enumerated, so the scrub is
// an ALLOWLIST: every query parameter is dropped unless its name is known
// safe. Missing an unknown credential parameter is impossible by construction.
//
// URLs also escape the attribute bag. When a request fails, Effect's error
// types embed the raw URL in their `message` (`TransportError.message` is
// "Transport: … (GET <url>)"), and the `@effect/opentelemetry` bridge copies
// that message into the span's exception EVENT attributes
// (`exception.message`, `exception.stacktrace`) and into `status.message`. The
// processor therefore scrubs three channels: attributes, events, and status.
//
// The scrub runs at the span-processor seam rather than at the route, because
// this is the only chokepoint every span in the isolate must pass through on
// its way to the exporter — worker spans, Effect spans, Durable Object spans,
// and any route added later. A per-route middleware or a `TracerDisabledWhen`
// override would only cover the routes someone remembered to wire it into, and
// overriding the middleware's attribute handling would mean forking Effect
// internals.
//
// `url.path` is deliberately preserved: route-level visibility is what makes
// these traces worth exporting at all. Only query parameters and userinfo are
// removed, and their presence is recorded as a stripped-key list so a trace
// still shows that the request carried a `code`, without its value.
// ---------------------------------------------------------------------------

import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/** Query parameters that are known safe to export and useful for debugging.
 *  Matched case-insensitively against the parameter name. Everything NOT
 *  listed here is dropped: credentials arrive under arbitrary names (`key`,
 *  `token`, provider-specific spellings), so the only safe default is
 *  redaction. Add a name here only when its values can never be secret. */
const SAFE_QUERY_KEYS: ReadonlySet<string> = new Set([
  // Enumerable OAuth error code (`error=access_denied`) — never a secret.
  "error",
  // Workspace/tenant selectors on app routes (`?owner=org`, callback `domain`).
  "domain",
  "owner",
  // Post-login redirect path. Its VALUE may itself carry a query string (the
  // login redirect round-trips the whole OAuth callback URL), which is
  // redacted recursively below — only the path portion survives.
  "returnto",
]);

/** Span attributes whose value is a whole URL. */
const URL_ATTRIBUTES = ["url.full", "http.url"] as const;
const QUERY_ATTRIBUTE = "url.query";
/** Names of the parameters removed from this span's URL attributes (plus the
 *  marker `userinfo` when a `user:password@` component was dropped).
 *  Non-secret by construction — it is the key list, never the values. */
export const STRIPPED_QUERY_ATTRIBUTE = "url.query.stripped_keys";

const isSafe = (key: string): boolean => SAFE_QUERY_KEYS.has(key.toLowerCase());

/** How deep to follow a query parameter whose value is itself a URL or path
 *  with a query string. Depth 2 covers the real nesting in this app —
 *  `/login?returnTo=%2Fapi%2Foauth%2Fcallback%3Fcode%3D…` (see
 *  `auth/return-to.ts` and the sign-in redirect in `start.ts`) — with headroom,
 *  and bounds the work per span. */
const MAX_NESTED_DEPTH = 2;

/** The query string with every parameter dropped except the allowlisted ones,
 *  plus the names dropped. Parsed with `URLSearchParams` so encoding
 *  round-trips correctly.
 *
 *  An allowlisted parameter whose own value carries a nested query string is
 *  redacted recursively rather than passed through: the login redirect
 *  round-trips the whole OAuth callback path through `returnTo`, so the
 *  credential rides inside another parameter's value. Past the depth bound the
 *  nested query is dropped wholesale — too deep to prove safe. */
const redactQuery = (
  query: string,
  depth = 0,
): { readonly query: string; readonly stripped: readonly string[] } => {
  const params = new URLSearchParams(query);
  const stripped = new Set<string>();
  for (const key of Array.from(new Set(params.keys()))) {
    if (!isSafe(key)) {
      stripped.add(key);
      params.delete(key);
      continue;
    }
    const values = params.getAll(key);
    const rewritten = values.map((value) => {
      const separator = value.indexOf("?");
      if (separator === -1) return value;
      if (depth >= MAX_NESTED_DEPTH) {
        stripped.add(`${key}.query`);
        return value.slice(0, separator);
      }
      const nested = redactQuery(value.slice(separator + 1), depth + 1);
      for (const name of nested.stripped) stripped.add(`${key}.${name}`);
      return nested.stripped.length === 0
        ? value
        : `${value.slice(0, separator)}${nested.query === "" ? "" : `?${nested.query}`}`;
    });
    if (rewritten.every((value, index) => value === values[index])) continue;
    params.delete(key);
    for (const value of rewritten) params.append(key, value);
  }
  return stripped.size === 0
    ? { query, stripped: [] }
    : { query: params.toString(), stripped: Array.from(stripped).sort() };
};

/** The URL with userinfo removed and every non-allowlisted query parameter
 *  dropped. Path, host, and scheme are untouched. An unparseable value is
 *  degraded textually — truncated at its first `?` (modulo allowlisted
 *  parameters) and shorn of any `user:password@` prefix — never passed
 *  through: if it cannot be parsed it cannot be proven safe. */
const redactUrl = (
  value: string,
): { readonly url: string; readonly stripped: readonly string[] } => {
  const stripped = new Set<string>();
  if (!URL.canParse(value)) {
    const separator = value.indexOf("?");
    let head = separator === -1 ? value : value.slice(0, separator);
    let query = "";
    if (separator !== -1) {
      const redacted = redactQuery(value.slice(separator + 1));
      for (const name of redacted.stripped) stripped.add(name);
      query = redacted.query;
    }
    const userinfoEnd = head.lastIndexOf("@");
    if (userinfoEnd !== -1) {
      stripped.add("userinfo");
      head = head.slice(userinfoEnd + 1);
    }
    return stripped.size === 0
      ? { url: value, stripped: [] }
      : {
          url: `${head}${query === "" ? "" : `?${query}`}`,
          stripped: Array.from(stripped).sort(),
        };
  }
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") {
    url.username = "";
    url.password = "";
    stripped.add("userinfo");
  }
  if (url.search !== "") {
    const redacted = redactQuery(url.search.slice(1));
    for (const name of redacted.stripped) stripped.add(name);
    if (redacted.stripped.length > 0) url.search = redacted.query;
  }
  return stripped.size === 0
    ? { url: value, stripped: [] }
    : { url: url.toString(), stripped: Array.from(stripped).sort() };
};

/** Matches URL-shaped substrings inside free text — error messages, stack
 *  traces, status descriptions. The character class stops at whitespace and
 *  common delimiters so `(GET http://…)` captures only the URL. */
const URL_IN_TEXT = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>()[\]{}]+/g;

/** Free text with every embedded URL redacted (userinfo removed, query
 *  parameters allowlisted). This is how exception messages and status
 *  descriptions are scrubbed — they contain the URL mid-sentence, not as a
 *  whole attribute value. */
export const redactUrlsInText = (text: string): string =>
  text.replace(URL_IN_TEXT, (match) => redactUrl(match).url);

/** Rewrites the URL-bearing attributes of an in-flight span in place, dropping
 *  userinfo and non-allowlisted query parameters. Every other string attribute
 *  is scrubbed as free text, so a URL embedded in an error-message attribute
 *  cannot slip through either. Returns the parameter names removed from the
 *  URL attributes. */
export const redactSpanUrlAttributes = (attributes: Record<string, unknown>): readonly string[] => {
  const stripped = new Set<string>();
  for (const name of URL_ATTRIBUTES) {
    const value = attributes[name];
    if (typeof value !== "string") continue;
    const result = redactUrl(value);
    for (const key of result.stripped) stripped.add(key);
    if (result.stripped.length > 0) attributes[name] = result.url;
  }
  const query = attributes[QUERY_ATTRIBUTE];
  if (typeof query === "string") {
    const result = redactQuery(query);
    for (const key of result.stripped) stripped.add(key);
    if (result.stripped.length > 0) attributes[QUERY_ATTRIBUTE] = result.query;
  }
  for (const [name, value] of Object.entries(attributes)) {
    if (typeof value !== "string") continue;
    if ((URL_ATTRIBUTES as readonly string[]).includes(name) || name === QUERY_ATTRIBUTE) continue;
    const redacted = redactUrlsInText(value);
    if (redacted !== value) attributes[name] = redacted;
  }
  return Array.from(stripped).sort();
};

/** The mutable surface of a span the redactor needs: the attribute bag, the
 *  recorded events (exception events carry `exception.message` and
 *  `exception.stacktrace`), and the status (whose `message` carries the
 *  failing error's message). Both `Span` and `ReadableSpan` expose all three
 *  as plain mutable objects. */
interface RedactableSpan {
  readonly attributes: Record<string, unknown>;
  readonly events: ReadonlyArray<{
    name: string;
    attributes?: Record<string, unknown> | undefined;
  }>;
  readonly status: { message?: string | undefined };
}

/** Wraps a span processor so every span is scrubbed of credential-bearing URL
 *  components — in attributes, in event attributes, and in the status message
 *  — before the inner processor (and therefore the exporter) sees it.
 *
 *  The attribute rewrite happens in `onEnding`, the last hook the OTel SDK
 *  calls while the span is still mutable (`Span.end()` runs `onEnding` before
 *  setting `_ended`, so `setAttribute` still applies); `onEnd` receives a
 *  frozen `ReadableSpan`. `onEnding` is optional in the SpanProcessor
 *  interface, so `onEnd` re-checks the attribute bag and mutates it directly
 *  as a backstop for any SDK path that skips the earlier hook. Events and
 *  status have no setter on an ended span in either hook, so they are always
 *  scrubbed by direct mutation. */
export class UrlRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnding(span: Span): void {
    this.redact(span, (key, value) => span.setAttribute(key, value));
    this.inner.onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    this.redact(span, (key, value) => {
      span.attributes[key] = value;
    });
    this.inner.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  private redact(span: RedactableSpan, write: (key: string, value: string) => void): void {
    // Work on a copy so the redaction decision is made from the current values
    // and applied through the caller's writer (span API vs direct mutation).
    const draft: Record<string, unknown> = { ...span.attributes };
    const stripped = redactSpanUrlAttributes(draft);
    for (const [name, value] of Object.entries(draft)) {
      if (typeof value === "string" && value !== span.attributes[name]) write(name, value);
    }
    if (stripped.length > 0) write(STRIPPED_QUERY_ATTRIBUTE, stripped.join(","));

    for (const event of span.events) {
      const name = redactUrlsInText(event.name);
      if (name !== event.name) event.name = name;
      if (event.attributes === undefined) continue;
      for (const [key, value] of Object.entries(event.attributes)) {
        if (typeof value !== "string") continue;
        const redacted = redactUrlsInText(value);
        if (redacted !== value) event.attributes[key] = redacted;
      }
    }

    const message = span.status.message;
    if (typeof message === "string") {
      const redacted = redactUrlsInText(message);
      if (redacted !== message) span.status.message = redacted;
    }
  }
}
