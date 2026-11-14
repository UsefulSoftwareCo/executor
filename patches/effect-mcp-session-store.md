# MCP session store

Effect 4.1.4's Streamable HTTP server keeps each stateful session (the
`initialize` it negotiated and the client's log level) in the server's memory
only. Cloud serves MCP sessions from Durable Objects, which Cloudflare evicts
after about 70–140 s without a request and restarts on every deploy. The
client's next request then gets `404`, and it must initialize again, which costs
it about 3 s.

`effect@4.1.4.patch` adds a `sessions` option to `McpServer.layerHttp`, a
`SessionStore` with `save` and `load`. It changes `ai/McpServer` and
`ai/internal/mcpRuntime` / `mcpStatefulRuntime` in source and in the distributed
JavaScript and types:

- `initialize` saves the new session before its response carries the id:
  its negotiated `initialize` payload, encoded, as `StoredSession`.
- `logging/setLevel` saves the session again with the level.
- Before admitting a POST, the server loads a session id it does not hold. The
  store passes the stored value to the server's `restore`, which decodes it and
  registers it under the same id, with the protocol adapter of the stored version,
  and returns whether it did. A value it cannot decode, or a version this server no
  longer serves, returns `false` and leaves the id unknown, and the request gets
  `404` as before. The store runs `restore` between its read and its write, so it
  can refresh only a session the server accepted.
- Nothing else writes or reads the store. A request for a session in memory
  never touches it, so a warm request costs nothing more.
- A store holds protocol state only. The host authenticates every request and decides who may use a session.

The patch also adds `maxSessions` and `heldSession` to `McpServer.layerHttp`. The
server then keeps that many HTTP sessions in memory, by last use. A session owns
work while one of its POST requests runs, until its response has been sent,
stream included, or while `heldSession` says the application holds work for it.
Admitting an `initialize` takes its session's place in the same synchronous
step as the check, and a session opens only in a place taken that way, so
sessions and places together never pass the bound, however many `initialize`
requests are admitted together; a request that ends before its session opens
gives the place back. The place is taken with interruption masked until its
release is installed, and interruption is restored around the request's own
work. A request's hold on its session is acquired against the request's scope,
which closes once the response has been sent, its stream included, or when the
request ends any other way. A client that disconnects at any point strands
neither. Without `maxSessions` no place is kept. Taking a place past the bound forgets the least recently
used session that owns no work; its next request gets `404`. When every
session owns work, `initialize` is refused with `503`, `Retry-After: 1` and the
`-32013` resource-exhausted error. A stored session restored past the bound
takes a place the same way, and stays unknown (`404`) when there is none.
Without `maxSessions` every session stays for the server's life, because the
transport implements no session DELETE. A store, when present, can still
restore a forgotten session.

Without `sessions` nothing changes. The store is not consulted for stateless
2026-07-28 requests, which have no session. Resource subscriptions are kept only
for connection transports, and `layerHttp` has no GET stream or event
resumption, so a stored session needs nothing else.
