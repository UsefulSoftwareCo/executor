---
"@executor-js/sdk": minor
"@executor-js/execution": minor
"@executor-js/api": minor
---

Add the execution-observer foundation. The execution engine now emits a typed
lifecycle stream (`ExecutionStarted`/`Finished`, `ToolCallStarted`/`Finished`,
`InteractionStarted`/`Resolved`), plugins can subscribe via the new
`plugin.runtime.executionObserver` hook, and `makeExecutionStack` composes every
registered plugin's observer onto the engine. Behaviour is unchanged when no
plugin observes, making this the opt-in seam the execution-history and
execution-metrics plugins build on. Also exposes `Executor.owner` and enriches
the `mcp.execute` span with the run id and trigger.
