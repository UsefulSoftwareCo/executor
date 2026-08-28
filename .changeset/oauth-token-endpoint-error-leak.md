---
"executor": patch
---

**Keep token material out of OAuth token-endpoint error messages**

A token-endpoint failure renders a preview of the upstream body into its
message, and that message is persisted onto connection health, returned to the
caller, and carried into telemetry. On a malformed HTTP 200 the body being
previewed is a _successful_ token response, so an access token and a refresh
token could be rendered into it.

The preview is now built from an allowlist of fields that are safe to show
(`error`, `errors`, `error_description`, `error_uri`, plus `code`, `message`,
and `detail` nested inside them) instead of a denylist of fields to hide. A
field nobody anticipated is omitted by default rather than printed by default.
Keys stay visible and only non-allowlisted string values are replaced, so an
operator can still read the shape of what the server sent. `code` is readable
only when nested, because at the top level of a token response it is the RFC
6749 authorization code.

Form-encoded bodies take the same allowlist, the walk over a body is
depth-bounded, and the failure summary records the token endpoint's hostname
rather than its full URL, which can carry identifiers in its path.

On that same malformed-200 path the failure no longer keeps the underlying
rejection as its `cause`. That rejection carries the parsed token response, so
keeping it put the raw tokens back into anything that renders the whole failure
rather than only its message. Everything the path needs from the body — the
status, the error code, the redacted preview — is read before the failure is
built. A transport failure still keeps its cause, which is what tells a DNS miss
apart from a refused connection.

No public API changes. The dead-grant classification added for HTTP 200 refresh
refusals is unaffected: it reads the HTTP status, not the rendered preview.
