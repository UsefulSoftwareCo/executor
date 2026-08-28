---
"executor": patch
---

**Fix: allow MCP integrations to declare OAuth scopes when resource metadata omits them**

MCP OAuth methods can now carry an optional non-empty scope list. Declared scopes
take precedence over protected-resource scope discovery, so servers with fixed
scopes can connect even when their dynamically registered OAuth client has no
resource identifier. Existing integrations without declared scopes keep
discovering them from the server at connect time.
