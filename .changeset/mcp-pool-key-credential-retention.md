---
"executor": patch
---

**The MCP connection pool no longer keeps credentials in its cache key**

A pooled remote MCP session is looked up by a key describing the connection's identity, and that key included the connection's resolved credential values — plus the headers and query params those same secrets had already been rendered into. The key is retained as a `Map` key for the pool's lifetime, so the secret stayed readable in process memory long after the call that needed it had finished, with nothing left to read it.

The key is now the SHA-256 digest of that identity rather than the identity itself. Reuse is unchanged, because equal identities still produce equal keys, and separation is unchanged too: a rotated access token, a different rendered auth header and a credential carried in a query param each still dial a fresh session instead of reusing one authenticated as somebody else. Hashing the whole identity rather than only the fields known to be sensitive means a field added later is covered without anyone having to remember it carries a secret.

Nothing reads the key back — the pool only compares it, and it reaches no log, span or error message — so nothing observable changes.
