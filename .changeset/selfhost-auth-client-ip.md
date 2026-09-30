---
"@executor-js/host-selfhost": patch
"executor": patch
---

Key the self-host's sign-in rate limit on the real client IP. The server now stamps the connecting address on every auth request, so a directly exposed instance limits each client separately with no configuration and a client cannot spoof its address.

Behaviour change for proxied deployments: `x-forwarded-for` is no longer read on its own, because any client could set it. If Executor runs behind a reverse proxy, set both `EXECUTOR_TRUSTED_PROXY_HEADER` (the header the proxy sets, e.g. `cf-connecting-ip` or `x-real-ip`) and `EXECUTOR_TRUSTED_PROXIES` (the proxy's own IPs or CIDR ranges), otherwise all users share one sign-in bucket. The server logs one warning naming both variables when an auth request carries a proxy header and neither is set. List only the proxy addresses, never a range that also contains your users; if every hop is trusted no client IP is found and the bucket is shared again. Half-configured or malformed values refuse to boot.
