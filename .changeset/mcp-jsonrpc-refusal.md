---
"executor": patch
---

**Fix: an MCP server refusing a tool call with a JSON-RPC error (for example `-32602 Invalid params`) surfaced as `Internal tool error [id]`.** The server's answer is for the caller, so it now comes back as a typed `mcp_tool_error` failure carrying the server's message and JSON-RPC code, and the model can correct the arguments instead of reading an outage.
