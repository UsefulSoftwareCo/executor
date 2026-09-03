---
"executor": minor
"@executor-js/sdk": minor
"@executor-js/plugin-toolkits": minor
---

Serve every MCP endpoint as a projection of one executor. A toolkit endpoint (`/mcp/toolkits/<slug>`) now narrows the same executor the default `/mcp` endpoint uses instead of building a separate one, so workspace `require_approval` and `block` policies apply on toolkit endpoints too. Two new scoped endpoints share the same path: `/mcp/integrations/<slug>[,<slug>…]` exposes every tool of the named integrations, and `/mcp/tools/<tool id>` exposes one tool.

For plugin authors, `toolPolicyProvider` is replaced by `toolProjections`, and `executor.project(name)` returns a narrowed view over the same database.
