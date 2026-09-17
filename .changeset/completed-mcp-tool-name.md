---
"@executor-js/execution": patch
---

Completed MCP execute results now include `toolName` when a script successfully uses exactly one connected tool. Executions that use distinct tools remain unlabeled, and internal call provenance is not exposed in the MCP response.
