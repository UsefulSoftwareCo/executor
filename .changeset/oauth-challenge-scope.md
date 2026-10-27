---
"executor": patch
---

MCP OAuth now requests the scope named in the server's 401 Bearer challenge (`WWW-Authenticate: Bearer … scope="mcp offline_access"`) when connecting. The challenge's scope takes precedence over the protected resource metadata's `scopes_supported`, and the metadata list remains the fallback when the challenge names no scope. Servers built on better-auth's MCP plugin list only the resource scope in their metadata and require `offline_access` via the challenge — connections to them previously received no refresh token and showed Expired as soon as the first access token lapsed. Fixes #2304.
