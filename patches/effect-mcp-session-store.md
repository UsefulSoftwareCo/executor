# MCP session store

Effect 4.0.1's Streamable HTTP server keeps each stateful session (the
`initialize` it negotiated and the client's log level) in the server's memory
only. Cloud serves MCP sessions from Durable Objects, which Cloudflare evicts
after about 70–140 s without a request and restarts on every deploy. The
client's next request then gets `404`, and it must initialize again, which costs
it about 3 s.

`effect@4.0.1.patch` adds a `sessions` option to `McpServer.layerHttp`, a
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

Without `sessions` nothing changes. The store is not consulted for stateless
2026-07-28 requests, which have no session. Resource subscriptions are kept only
for connection transports, and `layerHttp` has no GET stream or event
resumption, so a stored session needs nothing else.
