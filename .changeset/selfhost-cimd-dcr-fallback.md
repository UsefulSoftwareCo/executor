---
"executor": patch
---

Allow self-hosted deployments whose CIMD document is unreachable by OAuth servers to use DCR for automatic MCP and discovered OpenAPI connections with `EXECUTOR_OAUTH_CIMD_ENABLED=false`. Unsetting the variable restores CIMD for new connections without rewriting integration settings, including legacy OpenAPI templates.
