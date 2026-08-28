---
"executor": patch
---

**An MCP health check no longer reports `healthy` when the connection's credential is missing**

Rendering skips an auth placement whose value is unresolved — that is the renderer's documented behaviour, and callers own the missing-value policy. The MCP health check had no such policy, so it dialled unauthenticated, and any server that lists tools without auth answered. `discoverTools` succeeding maps straight to `healthy`, so a connection whose credential was gone reported as healthy.

Health status is the signal telling a user to re-authenticate, which makes `healthy` the one answer it must never give in that state. The check now reports `expired` with the unresolved input names, mirroring the OpenAPI health check, which already did exactly this.

The MCP tool-invocation path already refused for the same reason. `resolveTools` is deliberately left alone — its own comment records that discovery tolerating unresolved credentials is intended, since an open server lists tools unauthenticated.
