# PostgreSQL connection tracing

`@effect/sql-pg` 4.1.4 traces SQL statements and transactions. With
`SpanPropagationEnabled` it adds a `db.connect` child span to a statement that waited
for a new session, covering the part of the connect it waited for. An attempt has no
span of its own: a failed or retried attempt, or one no statement waited for, is not
recorded. A slow first
transaction therefore includes an unexplained interval before its first query.

`@effect%2Fsql-pg@4.1.4.patch` adds a client `sql.connect` span around one
connection attempt: password resolution, the driver's existing network
connection and authentication effect, and `connectTimeout`. It ends when
PostgreSQL sends `ReadyForQuery`, or on failure or interruption. It adds no URL,
credentials, query text, or connection attributes. Config resolution and later
query execution are outside this span. The span records its
`db.connect.attempt`, starting at 1.

A failed attempt fails its span and records why as `db.connect.failure`, one of:

- `timeout`: the attempt reached `connectTimeout`. The timeout runs inside the
  span, so the attempt fails it; before late October 2026 the timeout
  interrupted the span from outside and it ended with status OK.
- `refused`: the connection was not accepted. The transport failed before its
  socket connected (a refused, unreachable or unresolvable host), or the server
  answered the startup with an error that is not about authentication, such as
  too many connections. Classified by when it failed, not by the socket error's
  text or code: workerd's `node:net` gives a refused connection no code.
- `auth`: authentication failed: SQLSTATE class 28, no password configured, or
  an exchange that could not complete.
- `other`: anything else, such as a password provider that dies, a connected
  socket that failed or closed during startup, TLS negotiation, or a response
  the driver could not read.

An attempt its caller interrupts records none and still ends interrupted. The
attribute changes no error, retry or timeout.

The patch changes both source and distributed JavaScript. It preserves lazy
pool acquisition, reuse, dead-connection replacement, idle release, and scoped
socket cleanup. It does not open a connection to measure it. The existing
`SqlClient.reserve` API could measure explicit reservation, but would require
an extra eager acquisition in application code.

The patch is generated with `bun patch` against the npm release. Regenerate it
when upgrading, and remove it if upstream adds equivalent connection tracing.
The driver drains an interrupted statement through `drainAborted`; the wire span wraps
that unchanged cancellation path.

The patch is ported from source: `dist/` and the type declarations are generated from
the patched `src/` with the release's own build settings, so the two copies cannot differ.

## Session object pool and batches

The patch also carries the pool behaviour Cloud's MCP session objects use: statement groups, one
caller per connection, `PgPool.held`, settling abandoned and unawaited statements, and the
`PgConnection.pipelined` batch that sends a tool call's statements in one write and one snapshot.
`notes/database-pool.md` describes them. Like everything else here they are in both `src/` and
`dist/`, so a port from either copy keeps them; only `dist/` is loaded.

## Connection retries

The patch also adds a `connectRetries` option (default `0`) to `PgConnection`
and `PgClient` configuration. A connection attempt that fails with a retryable
reason, such as a transport error or `connectTimeout`, is made again up to that
many times. Each attempt has its own `connectTimeout` and `sql.connect` span. Nothing has been sent on
a connection before `ReadyForQuery`, so this never repeats a statement; query
failures are not retried. Authentication failures are not retryable. A retried
attempt's span also records the previous failure's fixed driver message as
`db.connect.retry_reason`, for example `PgConnection: Connection timed out`;
server error text stays out of the span. Cloud's Worker event and Durable
Object pools set one retry (see `cloudDatabasePool` in
`apps/hosted/cloud/src/infrastructure/database.ts`).

## Statement wire timing

The patch also records wire timing for the driver's single-statement path,
including pinned transaction queries: frame byte count and elapsed milliseconds
from socket write to its callback, the first decoded PostgreSQL message,
`CommandComplete`, and `ReadyForQuery`. Cloud enables Effect's
`Statement.SpanPropagationEnabled`, so the statement's `sql.execute` span is
current while it runs; the timings are recorded on that span as `db.wire.*`
attributes. A statement without its own `sql.execute`, such as transaction
control, or any statement when propagation is off, records them on a `sql.wire`
span of its own. The driver patch alone does not enable that upstream option.
It does not log parameters, bytes, rows, SQL text, hostnames, or credentials.

`db.wire.clock = date-now` identifies the clock. In Cloudflare, it advances on
I/O; these fields cannot measure CPU-only work. Use native invocation CPU time
alongside them. A write callback means the local stream accepted the write, not
that the origin received it. A first-message delay still combines transport,
Hyperdrive scheduling, and origin work. These fields alone do not prove which
remote component delayed a query.

Multiplexed query pipelines and streaming cursors are outside this patch. The
Cloud product currently uses the default exclusive pool, with preparation off.
Fatal errors and cancellation still pass through the existing query machine.
A synthetic TCP peer holds the first response and then ReadyForQuery separately;
the test verifies these boundaries and checks that private values are absent.
Without the patch it fails on the missing wire span; with it all five tests pass.

## Exact server correlation

Cloud's event telemetry also installs `Statement.CurrentTransformer`. Sampled
native SQL statements receive a SQLCommenter `traceparent` comment containing
only the statement's trace and span IDs. The hook preserves bound parameters.
Fixed-width hexadecimal validation prevents external trace context from adding
SQL syntax. Unsampled statements and invalid IDs receive no comment.

This lets a stage database observer match `pg_stat_activity` and blocking PIDs
to a specific Axiom SQL span, instead of inferring a match from timestamps or
query patterns. Server insights may sample or collapse tags; a missing sampled
execution does not prove the origin did no work. Transaction control and auth's
separate Kysely driver are not decorated by this hook.

The sixth native-driver test checks the actual Parse/Bind bytes, retained bound
value, SQL comment and wire parent. Removing the event layer makes its comment
assertion fail on the undecorated `SELECT $1`.

## One repeat after a lost connection

Cloud's databases sit behind proxies (Hyperdrive, PlanetScale's routing) that sometimes end
connections without the client hearing of it until it next writes. A pooled connection then fails
its next statement with `PgConnection: Connection closed`. In production that happened to 805
statements between 7 and 14 November 2026, in bursts, through Hyperdrive and on direct
connections alike.

`PgPool.use` runs a callback whose connection was lost (`PgConnection.connectionLost`: closed, or a
socket error; not our own `Connection is closed`, a server error or a cancel) once more when:

- **it is all reads.** Every statement it queued or sent passed `PgConnection.readOnlyStatement`
  (`LeaseUse.wrote` is unset). A write counts from the moment it is queued, before any check, so a
  write is never repeated, sent or not: whether a sent write applied cannot be known.
- **it is not a held group's** (`PgPool.held`, as the session objects' tool-call batches are), and
  not nested in another run (the outer run decides);
- **it has not been repeated already.**

Transactions reserve a connection and never come through `use`. A pipelined batch marks each
statement it queues (`pipelineBatchUnsafe`), though its caller never fails with a lost connection
today: it takes each statement's result as an `Exit`.

**The classifier** (`readOnlyStatement`) reads a statement's text. A read is a `SELECT`, or a `WITH`
of `SELECT`s, naming no `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `COPY`, `LOCK`, `CALL`, `DO`
or `INTO`, no `FOR UPDATE`/`FOR NO KEY UPDATE`/`FOR SHARE`/`FOR KEY SHARE`, and none of `nextval`,
`setval`, `pg_advisory*`, `pg_try_advisory*`, `set_config`, `pg_notify`, `pg_terminate_backend`,
`pg_cancel_backend` and `lo_*`. Anything else is a write, including a `SELECT` behind a comment or
a parenthesis, `VALUES`, `TABLE`, `EXPLAIN` and `SHOW`. Not caught: a `SELECT` calling a
user-defined function with side effects. The product calls none outside a transaction (its
functions are triggers); one that does must run in a transaction.

**The repeat's connection is the pool's.** The repeat checks out a connection of the same pool,
opened after the loss. A burst usually kills many connections at once, and a half-open connection
cannot be told from a healthy one without using it, so every idle connection opened before the loss
that the repeat is handed is closed, healthy or not, and the pool opens another. Later statements
that would have used a healthy one reconnect: the price of not handing the repeat a second dead
socket. Each candidate is checked out in a scope of its own and closed before the next is taken,
because the pool stops counting an invalidated connection toward its cap while it is still checked
out. So no more connections than `maxConnections` are ever open at once: cap 4 with all 4 idle
connections dropped, one read, peaks at 4 open sockets (7 before this). The new connection stays
in the pool. Under the pool's acquire timeout, if it has one, like any checkout. Only on pools
where each connection serves one run at a time (`concurrency` 1), which is every Cloud pool: on a
pool sharing connections among runs, closing an older one could cut off a run using it.

**Latency.** A repeat costs one connect when the database can be reached, after closing any older
idle connections it is handed.
When it cannot, the repeat's connection gets the pool's usual two attempts (`connectTimeout`
2.5 s each in Cloud), so a read fails up to 5 s later than without the repeat. A caller with a
shorter deadline is not held to it: its timeout interrupts the repeat, which releases its
connection, and the caller gets its own timeout error instead.

**Recorded.** Each repeat is its own client span, `sql.connection.repeat`, inside the caller's
trace, with `db.connection.repeat` (`connection-lost`), `db.connection.repeat_reason` (the fixed
driver message), `db.connection.lost_age_ms` and `db.connection.lost_idle_ms` (the lost
connection's age and time since it last carried bytes), and `db.connection.repeat_outcome`
(`succeeded` or `failed`). A repeat that cannot reach the database either gives the caller the
first error with ` (one repeat on a fresh connection also failed)` appended; any other failure of
the repeat is its own. `cloud-database-placement.spec.ts` checks each case through a proxy that
drops connections this way (`apps/hosted/testing/connection-repeat-fixture.ts`).
