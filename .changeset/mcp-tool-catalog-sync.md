---
"@executor-js/plugin-mcp": patch
"@executor-js/sdk": patch
---

Keep MCP tool catalogs in sync with the server's live tool set. Previously a
connection's tools were listed once at create time and never updated unless the
integration's config changed or a user clicked Refresh, so server-side tool
changes silently broke invocations.

- `tools/list` discovery now follows `nextCursor` pagination per the MCP spec,
  so servers with paginated catalogs list completely instead of first-page-only.
- The client handles `notifications/tools/list_changed` received during a tool
  call and marks the connection's persisted catalog stale; the next tools read
  re-lists from the server.
- An unknown-tool rejection from the server (protocol error or the reference
  SDK's error envelope) returns a typed `mcp_tool_unknown` failure telling the
  caller to re-list, and marks the catalog stale so it heals on the next read.
- Remote catalogs now also refresh on read once older than a freshness TTL
  (`ExecutorConfig.toolsSyncTtlMs`, default 15 minutes, `null` to disable),
  covering servers that change tools without notifying.
- A failed listing (server unreachable, auth not ready) no longer wipes the
  previously persisted catalog; it is kept and retried after the TTL.
