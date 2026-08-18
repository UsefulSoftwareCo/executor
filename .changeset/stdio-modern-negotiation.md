---
"@executor-js/plugin-mcp": patch
---

**Stdio MCP servers can negotiate the modern protocol (`versionNegotiation: "auto"`)**

Spawned stdio MCP integrations previously always opened with the legacy 2025 `initialize` handshake, so an SDK v2 server running with its legacy compatibility lane disabled could not connect. Stdio integrations now accept `versionNegotiation: "auto"` (on `mcp.addServer` and the stored config) to probe `server/discover` per spec 2026-07-28, falling back to `initialize` on legacy servers. The default stays `legacy`: the SDK's stdio probe costs an extra short-lived child process per connect and stalls on silent legacy servers, which is the wrong trade for spawn-per-call CLI servers. The connect handshake span now records the negotiated era (`plugin.mcp.protocol_era`) so integration authors can verify which handshake a connection used.
