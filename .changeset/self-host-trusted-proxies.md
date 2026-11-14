---
"@executor-js/hosted-self-host": patch
---

Self-host behind a reverse proxy can rate-limit each client instead of the proxy. Set
`EXECUTOR_TRUSTED_PROXIES` to the proxies' comma-separated addresses, or CIDR ranges that hold only
proxies: a request from one of them takes its client from `X-Forwarded-For`, read from the right
past every trusted address. When every listed address is a proxy that appends the address it
received the request from, and no client connects from a listed address, what a client writes in
that header is never used. Requests from other addresses, or with the setting empty, keep using the
connection's address, as before. Startup fails on an entry that is neither an address nor a range.
The Docker image and the Compose build read the setting; running `src/main.ts` from source does not.
