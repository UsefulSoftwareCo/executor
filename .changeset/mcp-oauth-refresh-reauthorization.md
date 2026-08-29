---
"@executor-js/sdk": patch
"@executor-js/plugin-mcp": patch
---

**Rejected MCP OAuth grants now request reconnect without registering a disposable client**

Remote MCP catalog discovery used the MCP SDK's interactive OAuth fallback when an upstream rejected Executor's stored bearer with `401`. A background refresh cannot finish that browser authorization, but the SDK first fetched OAuth metadata and dynamically registered another client. Executor then preserved the old catalog under a generic degraded health verdict, so clients saw zero or stale tools without a reliable reconnect signal.

Executor now stops at the authenticated HTTP boundary for OAuth-backed MCP transports. A rejected stored bearer becomes a structured reauthorization result before OAuth discovery or Dynamic Client Registration runs. Catalog refresh still preserves the last authoritative tools, but records the connection as expired with a reconnect-required detail so the UI and API can direct the user through authorization again.

API-key and unauthenticated MCP transports keep their existing `401` behavior, and ordinary incomplete discovery results remain degraded.
