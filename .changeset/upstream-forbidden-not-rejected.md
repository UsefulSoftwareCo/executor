---
"executor": patch
---

An upstream HTTP 403 from an OpenAPI or GraphQL tool no longer claims the connection's credentials were rejected unless the response says so (an authentication challenge, a credential error code, or a message naming a bad credential). Other 403s, such as a feature gated by the account's plan, fail with `upstream_forbidden` and the upstream's own message. Rejected-credential failures now include the upstream's message too, so MCP callers see the reason in the text result.
