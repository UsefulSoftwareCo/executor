---
"executor": patch
---

Add `executor.cache`, a host-pluggable key-value cache on the SDK surface: `ExecutorConfig.cache` accepts an Effect KeyValueStore (Cloudflare KV adapter included via `@executor-js/cloudflare/key-value-store`), with a bounded in-memory TTL fallback otherwise.
