---
"@executor-js/sdk": patch
---

Require evidence before a connection is marked permanently expired, and let the health probe refresh before it answers `expired`.

A refresher whose grant is refused now reads the stored refresh token again. When a peer instance rotated that token while the request was in flight, the call adopts the access token the peer persisted and records no rejection. Previously the loser of a concurrent refresh wrote `oauthReauthRequiredAt` onto a connection that still held a valid rotated refresh token. Every surface then answered `expired` without probing, and no tool call could refresh it again: only a re-authorization recovered it. The record is also skipped when `expires_at` moved forward during the grant, which is the same peer success read from the row.

`isPermanentTokenRejection` no longer reads 408, 425, or 429 as a definitive refusal. One rate-limited minute at a token endpoint therefore no longer ends a grant. Those statuses now behave like a 5xx response, and the next call retries.

`connections.checkHealth` re-mints the token once and probes again before it answers `expired` for an OAuth connection. A revoked token, an idle timeout shorter than the advertised lifetime, or a null `expires_at` therefore no longer shows a working connection as dead.

A connection whose integration declares no probe operation is now asked of the plugin first. A plugin that can answer without a spec — MCP lists its tools — gives a real verdict for its OAuth connections, which the credential-only branch never reached. Only when the plugin itself answers `unknown` does the credential-only verdict replace it, and that verdict is now computed from the values the probe already resolved, so nothing refreshes twice. A credential that resolves to nothing reads as `expired` there too, matching the plugins and heal-on-use.

A refresh response that omits `expires_in` no longer erases `expires_at`. RFC 6749 makes the field optional, so an authorization server that advertised a lifetime on the code exchange and omitted it on refresh used to disable proactive refresh for the rest of the connection's life. The mint now records the advertised lifetime in `provider_state.oauthTokenLifetimeMs`, and a refresh without `expires_in` derives the expiry from it.

A 403 scope shortfall on a probe now reads as `degraded` rather than `expired`: the credential authenticated, the grant is too narrow, and the remedy is a new consent rather than a reconnect.

The test authorization server's MCP resource endpoint (`serveOAuthTestServer` at `/mcp`) now speaks the JSON-RPC protocol honestly: it answers the request's own id, answers `tools/list` with an empty catalog, and stays silent for notifications. The previous canned reply used a fixed id, so any client that completed the handshake waited forever for its `tools/list` response and every catalog sync or liveness probe against the endpoint timed out at the discovery deadline — a limitation invisible while OAuth health checks never dialled, and exposed once they do.
