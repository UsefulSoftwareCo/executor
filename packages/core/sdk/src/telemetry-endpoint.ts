// ---------------------------------------------------------------------------
// Endpoint sanitization for span attributes.
//
// User-supplied endpoints are a credential carrier: `?token=…` in the query
// string and `user:pass@host` userinfo are both first-class supported input
// shapes (the MCP preset list ships a query-token URL, and the add-flow passes
// the raw paste straight through). Stamping such a URL verbatim onto a span
// ships the credential to the trace backend.
//
// Span attributes may carry hostnames, paths, and booleans; they may never
// carry the secret-bearing parts of a URL. `endpointForTelemetry` keeps the
// scheme/host/path — the parts that make a trace debuggable — and drops the
// query, fragment, and userinfo. `endpointTelemetryAttributes` adds the
// non-sensitive companions (origin, and whether a query string was present) so
// "the user pasted a URL with credentials in it" stays diagnosable without the
// credential itself.
// ---------------------------------------------------------------------------

/** Fallback for input `URL` cannot parse. A malformed paste can still carry
 *  every credential shape (`user:password@`, `?token=…`, `#access_token=…`),
 *  so it must never pass through verbatim — degrade by truncation instead.
 *  Everything from the first `?` or `#` is dropped (an unparseable query
 *  string cannot be proven credential-free), and anything before a remaining
 *  `@` is dropped with it (it may be userinfo; over-stripping is the safe
 *  direction here). The `hadQuery` / `hadFragment` booleans are honest: a `?`
 *  after the `#` is fragment content, not a query, and a fragment-only paste
 *  reports no query. */
const opaqueEndpoint = (
  endpoint: string,
): {
  readonly sanitized: string;
  readonly hadQuery: boolean;
  readonly hadFragment: boolean;
  readonly hadUserinfo: boolean;
} => {
  const queryStart = endpoint.indexOf("?");
  const fragmentStart = endpoint.indexOf("#");
  const cut = endpoint.search(/[?#]/);
  const beforeCut = cut === -1 ? endpoint : endpoint.slice(0, cut);
  const userinfoEnd = beforeCut.lastIndexOf("@");
  return {
    sanitized: userinfoEnd === -1 ? beforeCut : beforeCut.slice(userinfoEnd + 1),
    hadQuery: queryStart !== -1 && (fragmentStart === -1 || queryStart < fragmentStart),
    hadFragment: fragmentStart !== -1,
    hadUserinfo: userinfoEnd !== -1,
  };
};

/** The endpoint with every credential-bearing component removed: query string,
 *  fragment, and `user:pass@` userinfo. Unparseable input degrades through the
 *  same textual truncation — never verbatim, because a malformed paste is
 *  exactly where a stray credential hides. */
export const endpointForTelemetry = (endpoint: string): string => {
  if (!URL.canParse(endpoint)) return opaqueEndpoint(endpoint).sanitized;
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
};

/** Span attributes describing an endpoint without exposing its credentials.
 *  `<prefix>` is the sanitized URL, `<prefix>.origin` the scheme+host, and the
 *  booleans record which credential-bearing components (query string,
 *  fragment, userinfo) were stripped. */
export const endpointTelemetryAttributes = (
  prefix: string,
  endpoint: string,
): Record<string, string | boolean> => {
  if (!URL.canParse(endpoint)) {
    const opaque = opaqueEndpoint(endpoint);
    return {
      [prefix]: opaque.sanitized,
      [`${prefix}.has_query`]: opaque.hadQuery,
      [`${prefix}.has_fragment`]: opaque.hadFragment,
      [`${prefix}.has_userinfo`]: opaque.hadUserinfo,
    };
  }
  const url = new URL(endpoint);
  return {
    [prefix]: endpointForTelemetry(endpoint),
    [`${prefix}.origin`]: url.origin,
    [`${prefix}.has_query`]: url.search !== "",
    [`${prefix}.has_fragment`]: url.hash !== "",
    [`${prefix}.has_userinfo`]: url.username !== "" || url.password !== "",
  };
};
