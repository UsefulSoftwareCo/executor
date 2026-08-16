---
"@executor-js/sdk": patch
"@executor-js/plugin-mcp": patch
"@executor-js/plugin-openapi": patch
---

**Fix: a broken integration is no longer re-dialed on every freshness window, and concurrent reads no longer duplicate the same refresh**

A tools read refreshes stale tool catalogs before it answers, and the executor stamped the connection's last-synced time even when the listing failed. A server that had been unreachable for a month therefore reported as "synced 30 seconds ago", earned a fresh handshake every freshness window, failed again, and re-stamped — indefinitely. Handshakes that could only ever be refused, because the credential itself had been revoked, were the single largest share of that traffic. Separately, two reads arriving at once had no way to see each other, so both dialed the same server for the same catalog.

Connections now carry a real sync lifecycle. The last-synced stamp is written only by a listing that actually succeeded, so freshness is honest; a drift signal is recorded alongside it rather than erasing it, so "the catalog changed" and "this has never synced" are finally different states with different diagnoses. Failed listings walk a jittered retry ladder that doubles up to a six-hour ceiling, and a listing refused on authentication parks the connection until something that could plausibly fix it happens: an explicit refresh, a connection edit, an OAuth reconnect, or a healthy check. Before dialing, a refresh claims the connection with a leased write token, so exactly one of any number of concurrent readers does the work and the rest answer from the existing catalog; a claimant that loses its lease discards its result instead of overwriting a newer one.

Plugins can now classify an incomplete listing as `auth`, `unreachable`, `protocol`, or `config` via `ResolveToolsResult.incompleteKind`. The MCP plugin reports the first three from the handshake (including reauthorization demands and 401/403 responses, which it previously discarded), and the OpenAPI plugin reports `config`. The tools read's spans gained the claim outcome and per-reason skip counts.
