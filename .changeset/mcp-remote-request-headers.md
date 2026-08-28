---
"executor": patch
---

**Fix: add remote MCP servers that sit behind an authenticating proxy**

The add-MCP form now carries an optional request headers editor. The name/value
pairs are sent on the connection check and on every later request, so an
endpoint gated by an edge authenticator — a Cloudflare Access service token,
for example — can be discovered and added.

A `403` from such a gate is also no longer read as an unreachable server. It is
classified the same way a `401` is: the endpoint needs credentials, so the add
flow continues to the auth step instead of stopping on "Couldn't reach this
URL".
