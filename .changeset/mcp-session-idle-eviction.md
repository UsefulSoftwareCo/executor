---
"@executor-js/host-mcp": patch
---

Evict idle MCP sessions instead of holding them for the lifetime of the process. The in-process session store only released a session when the client sent `DELETE /mcp`, which the MCP client SDK's `transport.close()` never sends and a crashed client cannot send, so every `initialize` permanently retained an `McpServer`, its tool registry, and an `ExecutionEngine`. Sessions are now stamped on create and on each request, and a timer disposes anything idle past `sessionIdleTtlMs` (30 minutes by default). An open server-to-client stream does not defer eviction, matching how cloud's session alarm destroys a session once it passes its running-lease ceiling; an evicted id answers 404 `-32001`, which is the client's cue to re-initialize.
