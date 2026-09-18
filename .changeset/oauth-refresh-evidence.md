---
"@executor-js/sdk": patch
"@executor-js/plugin-mcp": patch
"@executor-js/plugin-openapi": patch
"@executor-js/plugin-graphql": patch
---

Stop recording a permanent **Expired** verdict without evidence, and stop the refresh races that produced one.

A refresher whose grant is refused now reads the stored refresh token again; when a peer instance rotated it during the request, the call adopts the access token that peer persisted and records nothing. Previously the loser of a concurrent refresh wrote `oauthReauthRequiredAt` onto a connection that still held a valid rotated refresh token, and every surface then answered `expired` without probing — no tool call could refresh it again, only a re-authorization recovered it. The record write is also skipped when `expires_at` moved forward during the grant, which is the same peer success read from the row.

`isPermanentTokenRejection` no longer reads 408, 425, or 429 as a definitive refusal, so one rate-limited minute at a token endpoint no longer ends a grant; those statuses behave like a 5xx and the next call retries. A refresh response that omits `expires_in` (RFC 6749 makes it optional) no longer erases `expires_at`: the mint records the advertised lifetime in `provider_state.oauthTokenLifetimeMs` and a refresh derives the expiry from it, instead of disabling proactive refresh for the rest of the connection's life.

`connections.checkHealth` re-mints once and probes again before it answers `expired` for an OAuth connection, so a revoked token, an idle timeout shorter than the advertised lifetime, or a null `expires_at` no longer shows a working connection as dead until a tool call heals it. The plugin is asked first with or without a declared health-check spec, so a plugin whose probe needs no spec (MCP lists tools) gives its OAuth connections a real verdict; only a plugin that answers `unknown` falls back to the credential-only verdict, and that verdict now reports `expired` when a credential value resolves to nothing.

The MCP liveness probe takes the invocation pool's lease instead of dialling a second connection, bounded by the shared 15s discovery deadline; a probe of a stdio server no longer starts a second child process, which single-instance servers (Chrome DevTools MCP, Playwright MCP, `docker run -i`) refused — reporting a live, serving connection as broken on every page mount. A 403 scope shortfall on a probe reads `degraded` instead of `expired`, from either an RFC 6750 `WWW-Authenticate` challenge or a body marker. The GraphQL probe no longer reads a transport failure's prose as a dead credential (`connect EACCES: permission denied` on a socket is not an authentication verdict).

The test authorization server's `/mcp` resource endpoint now speaks JSON-RPC honestly — the request's own id, an empty catalog for `tools/list`, silence for notifications — where the old canned reply used a fixed id and left every completed handshake waiting forever for its `tools/list` response.
