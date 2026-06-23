---
"executor": patch
---

`connections.create` now accepts no-auth connections (the `none` template with
no credential), which previously failed validation with "Expected exactly one
provider credential origin". Agents can wire up public, no-auth integrations
(public MCP servers, public REST APIs) programmatically instead of bouncing
through the web UI. Templates that take a credential still require exactly one.
