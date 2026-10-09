---
"apps": patch
---

A tool invocation records how its time divides between Executor's own work, the app's own code,
upstream providers and a person answering an elicitation. Each instant belongs to the innermost
boundary in progress: every callback an app supplies runs in an `app.code` span, provider sessions
and requests are upstream, and the cache and workflow controls an app calls are Executor's
(`app.cache.call`, `app.workflow.control`). Boundaries carry
`executor.owner`. `app.call`, `app.query` and `app.mutate` spans carry `executor.upstream.wait_ms`,
`executor.elicitation.wait_ms`, `executor.authored_ms` and `executor.overhead_ms`, which add up to
the span's duration. Isolated invocations return the same timing beside their result so the host can
record Executor's own time per tool call. Promise calls from app code to `elicit`, the cache and
workflow controls now run in the invocation's telemetry.
