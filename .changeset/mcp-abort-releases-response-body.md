---
"@executor-js/plugin-mcp": patch
---

**Closing a remote MCP connection now ends its streamable-http SSE request**

On a supplied `httpClientLayer`, the fetch adapter wired the caller's `AbortSignal` only to the pending response promise, never to the response body, so closing a connection left the long-lived `GET` channel in flight forever — one abandoned request per dial. Under Bun each holds one of the 256 concurrent-request slots, so a long-running process eventually exhausts the pool and every connection starts failing with `MCP discovery timed out after 15000ms`. The response stream is now interrupted when the signal aborts.
