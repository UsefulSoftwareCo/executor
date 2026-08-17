---
"executor": patch
---

Fix toolkit MCP routes in the local daemon by reusing its owned SQLite database and sharing one scoped executor per toolkit instead of reacquiring storage and connector processes for every client.
