# pg-cloudflare cork/uncork

node-postgres sends an extended-protocol query as five messages: Parse, Bind,
Describe, Execute and Sync. It calls `stream.cork()` before them and
`stream.uncork()` after them so that Node sends one packet. `CloudflareSocket`
in `pg-cloudflare@1.4.0` has no `cork()`. Each message was a separate socket
write, so every parameterized query sent several small TLS records and then
waited for the server. Better Auth reaches Postgres through this path.

`pg-cloudflare@1.4.0.patch` adds `cork()` and `uncork()` with Node's counting
semantics. While corked, writes are buffered with their callbacks. The final
`uncork()` sends the buffered bytes as one write and completes every callback
with its result. `end()` flushes buffered bytes before the final write.
Uncorked writes are unchanged.

The patch changes the TypeScript source, the CommonJS build that the `workerd`
ESM entry re-exports, and its declarations. `@effect/sql-pg` already writes
each statement as one frame and does not use this package.

Remove this patch when upstream `pg-cloudflare` implements `cork()`.
