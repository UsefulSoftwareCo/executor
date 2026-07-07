---
"executor": patch
---

Treat a transient WorkOS outage during the MCP live-membership check as a retryable 503 instead of a Forbidden that destroys the session.
