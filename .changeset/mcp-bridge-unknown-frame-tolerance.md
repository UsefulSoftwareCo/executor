---
"executor": patch
---

Tolerate unknown MCP worker/DO bridge frame types: an unrecognized frame is now
ignored with a structured warning instead of being silently dropped, so
worker/DO version skew during a staged deploy stays observable and never breaks
a session's stream.
