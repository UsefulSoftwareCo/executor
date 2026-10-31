---
"@executor-js/hosted-self-host": patch
---

Self-host behind a reverse proxy can rate-limit each client instead of the proxy. Set
`EXECUTOR_TRUSTED_PROXIES` to the proxies' comma-separated addresses or CIDR ranges: a request
from one of them takes its client from `X-Forwarded-For`, read from the right past every trusted
address, so what a client writes in that header is never used. Requests from other addresses, or
with the setting empty, keep using the connection's address, as before. Startup fails on an entry
that is neither an address nor a range.
