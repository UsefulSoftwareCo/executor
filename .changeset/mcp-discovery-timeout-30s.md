---
"executor": patch
---

Wait up to 30 seconds, instead of 15, for an MCP server to connect and list its tools. Servers that cold-start or build a large tool catalog no longer show as degraded with `MCP discovery timed out after 15000ms`.
