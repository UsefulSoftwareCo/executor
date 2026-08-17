---
"@executor-js/host-mcp": patch
"@executor-js/cloudflare": patch
---

**MCP execution spans now carry the client identity (`mcp.client.*`)**

The `clientInfo` a client self-reports at `initialize` (or in a modern request's `_meta`) previously existed only on the initialize request itself, which has no session id yet, so execution telemetry could not be segmented by client. Execute, execute-action, and resume spans (and their descendants) now carry `mcp.client.name` / `mcp.client.version` / `mcp.client.title` alongside the existing session join keys. Cloudflare session Durable Objects persist the reported identity in session meta, so attribution survives cold restores; it feeds telemetry only, never behavior.
