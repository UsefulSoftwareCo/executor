---
"@executor-js/plugin-openapi": patch
---

A health probe that meets a 403 scope shortfall now reads as `degraded` rather than `expired`. The credential authenticated; the grant is narrower than the probe operation needs, and the remedy is a new consent with wider scope — which the connection's missing-scope affordance already offers. The old verdict told the user the connection was dead and sent them through a reconnect that could not widen the grant. Classification passes the response headers as well as the body, so an RFC 6750 `WWW-Authenticate: Bearer error="insufficient_scope"` challenge is recognised too.
