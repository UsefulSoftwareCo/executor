---
"executor": patch
---

**Fix: declare the OAuth application type during dynamic client registration**

Dynamic OAuth registrations now identify HTTPS callbacks as web applications
and loopback HTTP callbacks as native applications. This lets strict OAuth
servers validate Executor's redirect URI against the correct client type.
