---
"@executor-js/plugin-mcp": patch
"executor": patch
---

Fix: remote MCP servers that return a bare `401` without a usable
`WWW-Authenticate` challenge (e.g. Datadog's `mcp.datadoghq.com`) now trigger
the OAuth sign-in flow instead of falling back to the manual-credentials
prompt. When a `401` would otherwise be rejected, the endpoint probe also
checks for RFC 9728 protected-resource metadata at the path-scoped
well-known URL; a document there whose `resource` matches the endpoint is
enough to classify it as an OAuth-protected MCP server. The check stays
narrow — path-scoped metadata plus a `resource`-to-endpoint match — so a
generic OAuth-protected API is not misclassified as MCP.
