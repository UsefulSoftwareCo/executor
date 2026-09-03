---
"executor": patch
"@executor-js/plugin-openapi": patch
---

OpenAPI tools that cannot reach the upstream server now return an `upstream_unreachable` error with an actionable network message instead of `Internal tool error [id]`.
