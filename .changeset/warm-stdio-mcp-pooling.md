---
"@executor-js/plugin-mcp": patch
---

**Stdio MCP servers are kept alive between tool calls**

Every tool call on a stdio MCP integration used to spawn a fresh child process, run the full MCP handshake, call the one tool, and tear the child down — roughly a second of overhead per call for an `npx`-launched server, on every call. Remote and app-server connections already reused sessions through the connection pool; plain stdio now joins them, with the same five-minute idle window, the same hashed identity key (command, args, cwd, secret env, credential values, owner and connection all separate identities), and the same drop-on-transport-failure semantics. This matches how MCP clients drive stdio servers generally: one long-lived child per session, not one per call.

A server that genuinely depends on fresh-process semantics can opt out with `spawnPerCall: true` in its stdio config (also accepted by the add-server API). The Codex app-server bridge ignores the opt-out — its approvals are session state, so it must pool.
