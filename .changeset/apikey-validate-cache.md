---
"@executor-js/cloud": patch
---

**API key validation is cached per isolate**

Every MCP request and every API-key-authenticated `/api/*` request used to pay a live WorkOS round trip (~100-150ms) to validate the presented key, on every single request. The JWT bearer path beside it already verified locally against a JWKS cached for an hour; API keys had no cache at all.

Successful validations are now cached in a bounded per-isolate map for 60 seconds, keyed by the SHA-256 digest of the key value (never the raw credential). The MCP handler used to rebuild its whole auth layer (and with it the cache) on every request; it now builds the layer once per isolate, so the cache holds on both the `/api/*` and `/mcp` planes. Invalid keys and upstream failures are never cached, so probing bad keys cannot pollute the map and a freshly created key works immediately. The tradeoff: a revoked key remains usable for up to 60 seconds within an isolate that validated it before revocation — far tighter than the one-hour rotation window the JWT path already accepts.
