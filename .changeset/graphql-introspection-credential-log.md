---
"executor": patch
---

**GraphQL introspection no longer logs a credential carried in the endpoint URL**

`query` is a supported credential carrier, so a GraphQL endpoint can be reached with `?token=<secret>`. Introspection built its request from a URL **string**, and `HttpClientRequest.setUrl` keeps a string verbatim as `request.url`. Every `HttpClientError` renders `${method} ${request.url}` into its `message` getter, and introspection logs the raw failure cause — so on any transport failure or non-JSON response, the connection's secret was written to the process log.

The request is now built from a URL **object**, which moves the query into `request.urlParams` and clears it from `request.url`. The secret is therefore absent from the error message, and from anything else that renders the request URL. The credential still reaches the upstream: the client recombines url and urlParams when it executes the request. The endpoint's own query string is handled the same way, not just the separately-supplied query parameters, since a configured endpoint can carry a credential too.

**The query string is now normalized on the wire.** Recombination appends each pair through `URLSearchParams`, so the query is re-serialized in form-urlencoded form instead of passed through byte-for-byte:

- a space written as `%20` is sent as `+`
- `~` and `!'()` are percent-encoded
- a valueless `?flag` is sent as `flag=`

Key order, repeated keys, and already-encoded reserved characters are unchanged, and every parameter still decodes to the same value. This is not avoidable while the fix holds: raw query bytes only survive inside `request.url`, which is the one field every error message renders, so byte-transparency and keeping the credential out of the log cannot both hold. An upstream that signs its raw query string is the case to watch. The exact resulting URLs are pinned by test.

Two endpoints are now rejected up front with an `invalid-endpoint` failure rather than dialed:

- an endpoint that is not a valid URL, which cannot be split this way and would otherwise be sent without the query parameters it was asked to include
- an endpoint carrying userinfo (`https://user:pass@host/…`), which `URL` keeps in the origin, so it would stay in `request.url` and leak into error messages exactly the way a query-carried secret used to

Neither rejection echoes any part of the endpoint. A health check on such an integration now reports the invalid configuration and points the operator at the endpoint URL, instead of blaming the credential that was never sent.
