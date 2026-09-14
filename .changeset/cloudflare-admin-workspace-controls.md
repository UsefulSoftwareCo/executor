---
"executor": patch
---

Fix Cloudflare-hosted consoles failing to recognize administrators configured through `ADMIN_EMAILS`. The account member response now exposes the current Access principal's role, restoring workspace connection controls while server-side authorization remains authoritative.
