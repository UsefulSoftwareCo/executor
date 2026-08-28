---
"@executor-js/sdk": patch
---

**Creating a connection over an existing one is rejected instead of silently overwriting it**

`connections.create` used to upsert: a create with the same (owner, integration, name) replaced the saved connection and, for a pasted value, overwrote the stored secret itself. It now fails with the new `ConnectionAlreadyExistsError` and leaves the existing connection untouched. Remove the connection first, or pick a different name.

This adds one error to the wire contract: the `POST /connections` endpoint can answer **HTTP 409** with tag `ConnectionAlreadyExistsError`, and the `connections.create` core tool resolves the same case as `{ ok: false, error: { code: "connection_already_exists" } }`. The change is additive — no existing status, field, or success shape moves.

OAuth is unaffected. Fresh OAuth connects already resolve a taken name to the next free suffix through `newConnection`, and reconnect still re-mints the same connection on purpose.
