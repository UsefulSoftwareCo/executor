---
"apps": patch
---

A completed MCP tool call no longer sends `notifications/cancelled` for itself when its client
closes, and its result returns without waiting for the server to acknowledge the session's
`DELETE`. The session still ends after the reply, within the invocation, through the host's
background runner; a failed or cancelled call ends its session before returning, as before.
