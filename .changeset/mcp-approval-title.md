---
"executor": patch
---

Use an MCP tool's `title` annotation as its approval prompt whether or not the tool declares `destructiveHint`. A non-destructive tool gated by a `require_approval` policy used to show its raw tool address instead of the title. Whether a tool requires approval on its own is still decided by `destructiveHint` alone.
