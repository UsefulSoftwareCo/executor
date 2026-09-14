---
"executor": patch
"@executor-js/plugin-openapi": patch
---

OpenAPI tools that cannot reach the upstream server now return an `upstream_unreachable` error instead of `Internal tool error [id]`. The message names the integration and origin that could not be reached, `details` carries the sanitized `host` and errno-style `code` (`ECONNREFUSED`, `ENOTFOUND`, …), and the failure is logged with the same classification.
