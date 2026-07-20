---
"@executor-js/plugin-mcp": patch
---

Reuse downstream MCP sessions across tool calls. Remote MCP invocations now lease connections from a per-plugin-instance pool (one idle session per resolved credential identity, exclusive per invoke, 5-minute idle TTL) instead of dialing a fresh connection per call, so servers that key state by `Mcp-Session-Id` (workspace selection and similar) see consecutive calls in the same session. A reused session rejected with HTTP 404 is redialed once transparently; stdio transports and endpoint probing remain per-call.
