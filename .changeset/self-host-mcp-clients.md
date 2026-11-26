---
"@executor-js/hosted-self-host": patch
---

Self-host no longer refuses new MCP clients after 256 API keys or OAuth grants
have been used within half an hour. It keeps up to 512 clients
(`EXECUTOR_MCP_CLIENTS`), and when a new one would pass that it forgets the
least recently used client that has no request in flight and no program waiting
for approval. That client's next request gets `404` and it must initialize a
new session; a client that does not do so on its own needs reconnecting. One member holds at
most 256 of them (`EXECUTOR_MCP_CLIENTS_PER_USER`), so one member's
clients cannot push out everyone else's. When every client that could make room
owns work, a new client gets `503` with `Retry-After: 1`.
A setting that is not a whole number of at least 1 stops the server with an
error naming the setting.
