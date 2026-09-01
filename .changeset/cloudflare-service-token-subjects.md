---
"executor": patch
---

**Add: map Cloudflare Access service tokens to stable human subjects**

Cloudflare-hosted Executor instances can explicitly map a dedicated service
token to a human Access `sub`, allowing the token to use that subject's personal
connections. Mapped tokens remain non-admin members and do not inherit email or
group claims.
