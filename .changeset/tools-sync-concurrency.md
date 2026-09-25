---
"@executor-js/sdk": patch
---

`ExecutorConfig.toolsSyncConcurrency` sets how many stale tool catalogs one tools read rebuilds at once (default 10, unchanged). Each in-flight rebuild holds its resolved catalog in memory until its write commits, so memory-constrained hosts can narrow the fan-out; the Cloudflare host now rebuilds two at a time, keeping a full stale fan-out over large OpenAPI specs inside the Workers isolate limit.
