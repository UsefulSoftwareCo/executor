---
"executor": minor
---

Self-host can now allow a few exact local origins while `EXECUTOR_ALLOW_LOCAL_NETWORK` stays off. Set `EXECUTOR_ALLOWED_LOCAL_ORIGINS` to comma-separated `http(s)://<ip>:<port>` origins, such as a loopback API on the same host. Each entry must be an IP literal, so DNS never decides. Metadata addresses are refused, and every redirect is still checked. Other loopback and private addresses stay blocked.
