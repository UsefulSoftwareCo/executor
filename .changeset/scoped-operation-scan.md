---
"@executor-js/sdk": patch
"@executor-js/plugin-openapi": patch
---

Plugin storage key-prefix reads narrow in the database instead of loading the whole collection and filtering in memory. OpenAPI catalog rebuilds now read only the rebuilt integration's operations, decoding each once, where they previously loaded every OpenAPI integration's operations for each connection — the allocation that pushed Cloudflare-hosted sessions with large specs (for example Cloudflare's own API) past the Workers memory limit during tool search.
