---
"executor": patch
---

**Fix: broken artifact bindings showed empty data instead of an error.** An artifact call is a single tool invocation, so a code-mode `{ ok: false, error }` result is the call's failure — but the shell passed it through as query data, settling the query as success with no payload. Every artifact then coerced that to an empty list, so a deleted or renamed connection read as "0 results, synced just now" rather than an error. The shell now rejects on that envelope, so the component renders its error state.
