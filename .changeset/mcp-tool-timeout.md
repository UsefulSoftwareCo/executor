---
"executor": patch
---

Let an MCP integration set `toolTimeoutMs` to raise the active-work deadline for its tool calls, so servers whose tools legitimately run past 60 seconds stop failing at the one-minute mark.
