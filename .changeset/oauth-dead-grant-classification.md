---
"executor": patch
---

**Fix: OAuth refresh rejections with non-spec error bodies (e.g. Datadog) now surface as expired connections with a reconnect path, and definitively dead refresh tokens are no longer retried against the authorization server**
