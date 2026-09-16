---
"@executor-js/sdk": patch
"@executor-js/cloudflare": patch
"@executor-js/react": patch
"@executor-js/cloud": patch
---

Faster reads: a tools read no longer waits on TTL-expired remote catalogs (they re-list behind the read), the members list runs its lookups concurrently, cold isolates race the JWKS store against the upstream fetch, OAuth discovery documents are answered at the Worker entry, automatic connection health probes are deduplicated across remounts, and per-tool MCP registration spans are dropped.
