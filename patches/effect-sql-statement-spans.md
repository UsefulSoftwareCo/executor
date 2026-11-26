# SQL statement span names

Since Effect 4.0.2 a statement's span is named after its client's target: the
`db.namespace` (the database's name), else `server.address[:server.port]`, else
`db.system.name`, so `executor` on one stage and `postgresql` on PGlite. Effect 4.0.1
named every statement span `sql.execute`.

Executor's telemetry is written around that one name
([storage span names](../notes/telemetry.md#storage-span-names)): each statement is one
`sql.execute` span carrying `fumadb.operation` and `db.collection.name`, the driver
patch records `db.wire.*` timings on the `sql.execute` it runs under, the app
telemetry vocabulary lists it, and the dashboards and scenarios find statements by it.
A name that follows the database would differ on every stage. Effect has no setting
for it: `Statement.spanName` is a function of the client's attributes.

`effect@4.1.4.patch` changes `Statement.spanName` in `sql/Statement`, in source and
distributed JavaScript, to return `sql.execute` for every client. The target stays on
the span as `db.namespace` and `server.address`; `server.port` is dropped by the span
allowlist. Transaction control keeps Effect's own names: each `BEGIN`, `COMMIT`,
`ROLLBACK` and savepoint statement has a client span named after the operation and
the target, such as `COMMIT executor`, under `sql.transaction`.

`cloud-database-placement.spec.ts` reads a tool call's statements by this name.
Remove the patch when an Effect release lets a client name its statement spans.
