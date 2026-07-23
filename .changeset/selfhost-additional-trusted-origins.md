---
"executor": patch
---

Self-hosted instances can now allow additional browser origins without changing
their canonical public URL. Set `EXECUTOR_TRUSTED_ORIGINS` to a comma-separated
list of exact HTTP or HTTPS origins when one instance is intentionally reachable
through multiple hostnames or addresses. OAuth callbacks, MCP metadata, approval
links, and other generated URLs remain pinned to `EXECUTOR_WEB_BASE_URL`, and
origins are never inferred from request headers.
