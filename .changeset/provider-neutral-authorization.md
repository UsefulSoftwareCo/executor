---
"executor": patch
---

Add an optional provider-neutral authorization seam for tool execution. Hosts can supply an `AuthorizationProvider` that receives Executor-bound tenant/subject identity and resolved tool metadata before credentials or plugin invocation; deny and provider failures fail closed, approval reuses the existing elicitation path, and nested tool execution re-enters the same authorization check. Existing hosts that do not configure a provider retain current behavior.
