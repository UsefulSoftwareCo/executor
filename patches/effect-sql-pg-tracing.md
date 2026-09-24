# PostgreSQL connection tracing

The Effect snapshot pinned at `c7d1ffff` traces SQL statements and transactions,
but its physical PostgreSQL connection acquisition has no span. A slow first
transaction therefore includes an unexplained interval before its first query.

`@effect%2Fsql-pg@c7d1ffff.patch` adds a client `sql.connect` span around the
driver's existing network connection and authentication effect. It ends when
PostgreSQL sends `ReadyForQuery`, or on failure or interruption. It adds no URL,
credentials, query text, or connection attributes. Password/config resolution
and later query execution are outside this span.

The patch changes both source and distributed JavaScript. It preserves lazy
pool acquisition, reuse, dead-connection replacement, idle release, and scoped
socket cleanup. It does not open a connection to measure it. The existing
`SqlClient.reserve` API could measure explicit reservation, but would require
an extra eager acquisition in application code.

The patch key uses the exact package URL, not its shared prerelease version.
Bun 1.3.11 accepts and applies this key with `bun install --frozen-lockfile`.
Its `bun patch --commit` command crashes for this URL dependency, so this patch
and the corresponding text lock entry were generated directly. Keep the key
aligned with the package URL when upgrading, and remove this patch if upstream
adds equivalent connection tracing.

Verify the real driver's public pool/connection APIs against a synthetic TCP
startup peer:

```sh
node --test apps/hosted/cloud/test/sql-connect.test.ts
```

## Statement wire timing

The patch also adds `sql.wire` for the driver's single-statement path, including
pinned transaction queries. It records frame byte count and elapsed milliseconds
from socket write to its callback, the first decoded PostgreSQL message,
`CommandComplete`, and `ReadyForQuery`. Cloud enables Effect's
`Statement.SpanPropagationEnabled` so the executing SQL span becomes the wire
span's parent. The driver patch alone does not enable that upstream option.
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
