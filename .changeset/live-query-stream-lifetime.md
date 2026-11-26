---
"apps": patch
"@executor-js/hosted-self-host": patch
---

On self-host, a live app query stops running when the page that opened it
closes. The image serves its product from a Durable Object, and workerd never
cancelled a response stream after its client left, so every subscription a page
ever opened kept running its query every 15 seconds until the server restarted.
After 20 minutes of two tabs reloading a ten-query page every minute, a server
with no page open still ran about 13 queries a second.

A failed background cache refresh now logs why it stopped
(`cache.refresh.failure`: `timeout`, `cache` with the cache's reason, `loader`,
`invalid-value` or `defect`). Apps get this when they are rebuilt with this
release.
