---
"executor": patch
---

Add a host-provided cache primitive to the SDK executor surface. Hosts can now pass an Effect KeyValueStore to `createExecutor`, while executors without one use an in-memory fallback.
