---
"@executor-js/plugin-mcp": patch
---

Load the MCP client SDK lazily on first outbound connection instead of at module evaluation. Runtimes that bundle the plugin (notably Cloudflare Workers) no longer pay the client package's module-eval memory and CPU on startup or on code paths that never dial an MCP server.
