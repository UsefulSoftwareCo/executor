---
"@executor-js/sdk": patch
"@executor-js/plugin-openapi": patch
---

Batch OpenAPI operation metadata writes through plugin storage so adding large built-in OpenAPI sources no longer performs thousands of sequential D1 operations.
