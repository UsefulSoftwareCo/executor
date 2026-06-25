---
"@executor-js/sdk": patch
"@executor-js/plugin-openapi": patch
---

Reduce `tools.list` server time. The read path now skips the stale-connection-tools sync once every connection is synced at the current revision watermark (cached per binding and busted by any new config revision), instead of scanning connections on every call. The openapi operation store also filters `listOperations` by integration at the storage layer (a key-prefix `LIKE` covering both the hashed and legacy key schemes) rather than reading the whole collection and filtering in memory.
