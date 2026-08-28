---
"executor": patch
---

**Concurrent API requests no longer share one database provider build**

Every HTTP request gets its own database connection, opened when the request fiber's scope opens and closed when it closes. The middleware that builds a request's execution stack, however, captures the boot fiber's context once at layer-construction time and re-applies it to every request. A captured context carries Effect's current memoization map, and re-applying it replaced the fresh per-request map with the boot one — which every in-flight request in the isolate shares.

The per-request stack build then memoized itself there. Sequential requests still rebuilt, because the memo entry is released once the request that built it finishes, so the problem was confined to requests that overlap: the second request reused the first one's stack build, and with it the first one's database connection. A request could therefore issue queries on a connection it did not own, and lose that connection mid-flight when the owner finished and closed it — typically surfacing as a failed read after a slow outbound call, on a request that had already read successfully.

The stack is now built with a request-local memoization scope, so overlapping requests each build their own stack over their own connection. The captured context still carries the long-lived services it exists to carry. The two other per-request provider builds that ran under a captured context — the account provider and the admin-users provider — are built the same way, for the same reason.
