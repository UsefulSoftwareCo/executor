---
"@executor-js/sdk": patch
---

**Stale "unhealthy" verdicts no longer wait for a manual "Check now"**

A connection's persisted health verdict was only ever re-checked from the web UI, so after one bad probe (a transient upstream error, a refresh that failed once) agents reading `connections.list` kept reporting "unhealthy, reconnect" for a connection that worked fine — invocation auto-refreshes OAuth tokens — until a human opened the page and clicked "Check now".

Two repair paths make the verdict track reality on its own. The agent-facing `connections.list` now re-runs the same probe as "Check now" before reporting a non-healthy verdict older than a minute, so recovery shows on the next read while repeated lists collapse to one probe per window. And a successful tool invocation through a connection wearing a non-healthy verdict flips it back to healthy — real traffic is stronger evidence than any probe. Tool-sync failure verdicts and grants the authorization server has rejected as `invalid_grant` are deliberately left alone: the first is cleared only by a successful sync, and the second genuinely requires a reconnect. A call whose credential no longer resolves is left alone too — a rendered request omits the missing placement, so an upstream that answers unauthenticated proves nothing about a credential that is gone.

`PluginCtx.connections` gains `checkHealth`, the same probe-with-freshness-window the executor surface already exposed.
