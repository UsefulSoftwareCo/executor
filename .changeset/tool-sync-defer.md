---
"@executor-js/sdk": patch
"@executor-js/api": patch
"@executor-js/local": patch
"@executor-js/host-selfhost": patch
"@executor-js/host-cloudflare": patch
"@executor-js/cloud": patch
---

**Fix: an old-but-working tool catalog no longer makes a tools read wait for an upstream handshake**

A tools read re-lists any connection whose catalog is due, and until now it waited for every one of them before it answered. Most of that waiting was speculative. A catalog goes due for four reasons, and only three of them are somebody telling us it changed: the connection has never synced, a drift signal arrived mid-invocation, or the integration's configuration was revised. The fourth is only the clock — the freshness window elapsed on a connection whose catalog works and which nothing has reported as wrong. Re-verifying it is worth doing soon; it was never worth making a caller wait for, and on a workspace with several MCP servers it was the bulk of what a read paid for.

Reads now split the two. The three invalidation triggers still re-list inline, because the answer the read is about to give is wrong until they run. An expired catalog is served as it stands and its listing is handed to the host to run once the read has answered, through a new optional `ExecutorConfig.deferToolSync`. A connection that both drifted and expired is an invalidation and stays inline; that falls out of the existing classification rather than needing a rule. The refresh claim is taken inside the deferred listing rather than when it is queued, so a batch that is enqueued and then never runs — an evicted isolate, a dropped background task — leaves no lease behind and the connection is simply offered again on the next read. Each read defers at most sixteen connections, because the background budget on the tightest host is a Cloudflare `waitUntil`; the rest stay due and are picked up by the following read, and both counts are reported on the read's span alongside the existing sync counters.

A host with no way to outlive its own response leaves `deferToolSync` unset and the batch runs inline, which is the same work in the only order that host can do it in. The local daemon, self-host and the Cloudflare host run it detached; the cloud MCP session, whose database handle lives as long as the session, runs it under the session's `waitUntil`. Cloud's HTTP API plane deliberately does not: its postgres socket is released while the response is still a value, so there is no moment on that plane that is both after the response and before the connection closes.
