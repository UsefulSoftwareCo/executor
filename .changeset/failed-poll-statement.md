---
"@executor-js/sdk": patch
"@executor-js/telemetry": patch
---

A failed poll's root span now names the statement that failed: its operation,
its table and the database's kind of failure, never its SQL or values.
