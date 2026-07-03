---
"@executor-js/cloudflare": patch
---

Upgrade `agents` to 0.17.3 and patch its MCP SSE forwarder to bound undrained frames per connection. A slow or stalled streamable-http client previously caused forwarded frames and keepalives to accumulate unboundedly in the shared front-worker isolate, OOMing it and dropping every co-tenant on that isolate. The patch caps per-connection undrained data at 8 MiB and closes the offending stream instead of buffering without limit.
