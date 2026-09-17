---
"@executor-js/sdk": patch
---

Require evidence before a connection is marked permanently expired, and let the health probe refresh before it answers `expired`.

A refresher whose grant is refused now reads the stored refresh token again. When a peer instance rotated that token while the request was in flight, the call adopts the access token the peer persisted and records no rejection. Previously the loser of a concurrent refresh wrote `oauthReauthRequiredAt` onto a connection that still held a valid rotated refresh token. Every surface then answered `expired` without probing, and no tool call could refresh it again: only a re-authorization recovered it. The record is also skipped when `expires_at` moved forward during the grant, which is the same peer success read from the row.

`isPermanentTokenRejection` no longer reads 408, 425, or 429 as a definitive refusal. One rate-limited minute at a token endpoint therefore no longer ends a grant. Those statuses now behave like a 5xx response, and the next call retries.

`connections.checkHealth` re-mints the token once and probes again before it answers `expired` for an OAuth connection. A revoked token, an idle timeout shorter than the advertised lifetime, or a null `expires_at` therefore no longer shows a working connection as dead.
