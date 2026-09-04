---
"@executor-js/sdk": minor
"@executor-js/plugin-openapi": patch
"@executor-js/plugin-graphql": patch
"@executor-js/plugin-mcp": patch
"executor": minor
---

Add a passthrough MCP mode (`?mode=passthrough`, `executor mcp --mode passthrough`) that serves every connected integration tool as its own MCP tool, with workspace policy folded into each tool's annotations so the client's native approval flow applies. Adds `executor.tools.describeAll()` and a `readOnly` tool annotation.
