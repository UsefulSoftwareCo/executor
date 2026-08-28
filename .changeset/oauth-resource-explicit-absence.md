---
"executor": patch
"@executor-js/react": patch
---

**An OAuth app can now be registered without an RFC 8707 resource, and that absence holds on every request**

Microsoft Entra v2 rejects any authorization request that carries both a v2 `scope` (such as `https://api.fabric.microsoft.com/.default`) and the RFC 8707 `resource` parameter, failing with `AADSTS9010010` before the consent screen. Executor made that unavoidable for MCP servers behind Entra: registering an app for an MCP integration always derived the MCP endpoint as the resource, the form had no field to change it, and so every request carried the parameter Entra rejects.

The register/edit OAuth app form now shows the resource indicator. It is still prefilled for MCP servers — nothing changes for providers that accept the parameter — but it can be cleared, and a cleared value persists as "no resource". A resource-less app then omits `resource` on all four grants alike: the authorization request, the code exchange, token refresh, and client-credentials. Symmetry matters here — sending `resource` on authorize but not on the token request (or the reverse) would bind the two tokens to different audiences.

Two adjacent gaps closed with it:

- MCP scope discovery no longer depends on the app's resource. It now falls back to the integration's own discovery URL (the MCP endpoint), so clearing the resource does not break connecting.
- Token refresh for a first-party OAuth app dropped the app's configured resource, refreshing to a different audience than the original grant. It now sends the same resource the authorization request sent.

Apps that keep their resource — the default for every discovered MCP server — behave exactly as before: the parameter is sent on every grant, as the MCP authorization spec expects.
