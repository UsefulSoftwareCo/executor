---
"@executor-js/host-mcp": patch
"@executor-js/local": patch
---

**An unsupported method probed before `initialize` no longer kills the MCP connection**

Only `initialize` can open a session, so the streamable-HTTP transport answered every other pre-session method with HTTP 400 + `-32000 Server not initialized`. A 400 is a transport-level failure, so clients dropped the connection instead of treating it as one request failing — a client that opens with an optional probe (MCP 2026-07-28 clients lead with `server/discover`) was disconnected before it could fall back to `initialize`. Over `executor mcp`, which bridges this endpoint to stdio, that closed the client's pipe outright.

Pre-session dispatch now answers any method other than `initialize` with `-32601 Method not found` on a normal 200, which is a per-request error, so the connection survives and the handshake proceeds.
