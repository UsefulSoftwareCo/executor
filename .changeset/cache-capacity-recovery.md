---
"@executor-js/app-cache": patch
"apps": patch
---

Include the safe reason in CacheError messages and preserve it when reading through the host transport. Reclaim old, unleased cache entries at aggregate capacity without evicting the current write, and reload catalogs whose cached parts have been evicted.
