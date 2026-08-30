---
"@executor-js/cloud": patch
---

**Revoking an API key now invalidates its cached validation**

The per-isolate validation cache made a revoked key keep authenticating for up to 60 seconds. Two fixes close that: the cache map now lives at module scope, shared by every build of the key service (the account middleware rebuilds it per request, so a per-build map left the revoke invalidating a fresh empty cache), and both revoke paths drop the revoked key's entries from it. A revoked key is refused on the next request served by the isolate that processed the revoke; other isolates still age the entry out within the TTL.
