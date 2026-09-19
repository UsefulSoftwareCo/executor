---
"@executor-js/sdk": patch
---

Request every scope a resource advertises during OAuth scope discovery, bounded by an 8 KiB scope-string budget instead of a 100-scope count. Resources with many fine-grained scopes previously received a token missing the ones it needed. Health checks without a probe no longer replace a tool-sync failure verdict with "healthy".
