---
"executor": patch
---

**Tools reads stop waiting on slow upstream servers**

A tools read rebuilds every connection whose catalog has gone stale before answering. The rebuilds already ran concurrently, but the read still waited for all of them, so one slow or unreachable MCP server gated every catalog read behind its network timeout — a tools listing could take tens of seconds while healthy connections sat ready.

A read now waits at most a short grace budget (2 seconds by default) for the rebuilds, then answers from the persisted catalog. The rebuilds keep running after the read returns and land on a later read, so the catalog still converges — it just no longer holds the reader hostage while it does. Overlapping reads share one in-flight rebuild per connection instead of stacking new ones.

The budget is `toolsSyncGraceMs` on the SDK config. Pass `null` to restore the strict behavior, where a read blocks until every rebuild finishes and always reflects a fully converged catalog.
