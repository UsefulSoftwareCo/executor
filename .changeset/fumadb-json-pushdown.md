---
"@executor-js/fumadb": minor
"@executor-js/sdk": minor
---

Push JSON-document aggregation and keyset pagination down to SQL. FumaDB's query
layer gains `jsonCount`, `jsonGroupCount`, `jsonTimeBuckets`, `jsonStats`
(min/max + continuous percentiles), and `jsonPage` (cursor pagination) over a
JSON document column, implemented natively for the memory and Drizzle
(SQLite/Postgres) adapters and failing loudly on adapters that don't support
them. Plugin storage exposes this as `collection.aggregate.{count,groupCount,
timeBuckets,stats}` and `collection.queryKeyset(...)`, translating a
collection's indexed-field `where` into JSON-path predicates while owner/tenant
scoping stays enforced by the storage policy. Aggregates and pages are computed
in the database instead of by fetching the whole collection and reducing in
memory.
