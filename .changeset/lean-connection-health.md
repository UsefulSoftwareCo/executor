---
"@executor-js/sdk": patch
---

Keep `connections.list` health output compact unless callers opt into diagnostics with `verbose: true`. Default list responses now retain only the health status, identity, and check timestamp; verbose responses continue to include HTTP status, diagnostic detail, and bounded upstream response samples.
