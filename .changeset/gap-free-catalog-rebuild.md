---
"@executor-js/sdk": patch
---

Tool-catalog rebuilds no longer empty the catalog while they run. A rebuild now upserts the new tool and definition rows and then prunes only the names the upstream stopped listing, instead of deleting every row and re-inserting. On databases without interactive transactions (Cloudflare D1), each statement commits on its own, so a search during a rebuild used to find zero tools for that connection, and a rebuild cut off partway (or overlapping another session's rebuild) left the catalog partial; both now keep a complete catalog, and an interrupted rebuild stays stale and retries. Catalog rows are written in size-bounded calls, so a large spec's catalog (Cloudflare's own API) no longer exceeds D1's 32MiB batch limit.
