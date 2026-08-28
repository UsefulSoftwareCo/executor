---
"@executor-js/execution": patch
"executor": patch
---

**Opt-in per-integration search tools on the MCP surface**

Connecting with `?search_tools=true` (stdio: `executor mcp --search-tools`) adds one minimally-described `search_<integration>` MCP tool per connected integration, so the integration namespaces reach the model as tool names it can see without calling anything. Each call routes through the same flow as `tools.search({ namespace })` inside `execute`, and the tool list comes from the same inventory the `execute` description shows. Off by default; a clean endpoint URL is unchanged.
