---
"@executor-js/sdk": patch
"@executor-js/plugin-toolkits": patch
---

Toolkit sessions no longer walk the whole workspace catalog on connect, search, or describe: the toolkit's access patterns narrow the tool rows core reads. Tools reads no longer wait on re-listing catalogs that are only older than the freshness TTL; those rebuild in the background while the read answers from the persisted rows. Stale-marked and config-revised catalogs still gate the read within the grace budget.
