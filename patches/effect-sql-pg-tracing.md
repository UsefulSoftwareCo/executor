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
from socket write to its callback, the first raw socket-data callback, the first decoded PostgreSQL message,
`CommandComplete`, and `ReadyForQuery`. Cloud enables Effect's
`Statement.SpanPropagationEnabled` so the executing SQL span becomes the wire
span's parent. The driver patch alone does not enable that upstream option.
It does not log parameters, bytes, rows, SQL text, hostnames, or credentials.

`db.wire.started_at_ms` and `db.wire.ready_at_ms` use the same `Date.now()`
clock as the elapsed wire fields. Use these absolute timestamps for database
log joins. Effect's nanosecond wall clock can differ from `Date.now()` by up to
one second; adding a wire duration to a span timestamp mixes those clocks.

## Hyperdrive query protocol

The patch adds `flushUnnamedParse` for ordinary exclusive queries with unnamed
statements. Cloud enables it for Hyperdrive connections. The driver sends Parse
and Flush, waits for ParseComplete, then sends the original Bind, Describe,
Execute and Sync bytes. Direct Neon connections retain the pipelined protocol.
Named statements, multiplexed queries and streaming cursors retain their existing
behavior. Cloud already disables statement preparation and multiplexing.

A concurrent synthetic replay reproduced 66 reads over five seconds among
4,118 original profile reads. Waiting for Parse acknowledgment had zero among
3,974 reads, with a maximum of 622 ms. Adding Flush to the original single write
still stalled. Full database logs contained exactly one execution for each of
the replay's 15,715 profile reads. The stalls preceded the database's fast
Parse/Bind/Execute phases. This identifies an affected protocol interaction on
the Hyperdrive path; it does not establish which internal transport mechanism
causes it. Production rollout and its resulting incident rate require separate
verification.

A second 64-caller replay reproduced ten stalls over five seconds among 1,747
original reads, and ten among 1,665 reads split with a 100 ms delay. Waiting for
ParseComplete had zero among 1,734 reads in that same run. All 45 reads over
three seconds had one exact database execution, with Parse, Bind and Execute
durations below 0.4 ms. Independent health requests completed during a captured
6.7-second wait. The clean implementation then completed 5,808 profile reads at
64 callers with no diagnostic probes: p99 480 ms, maximum 1,102 ms, none over
three seconds. All 5,808 delivered spans contained the new phase timestamps.

This removes the reproduced profile stall, but adds a round trip to each
unnamed query. The clean run's complete HTTP requests still had a 13.9-second
p95 under 64 callers. That overload result does not establish an improvement to
the dashboard's entire latency distribution.

The protocol adds one round trip, with no retries or cached application data.
`db.wire.protocol_mode`, `db.wire.parse_complete_ms`, `db.wire.bind_sent_ms`,
`db.wire.bind_write_callback_ms` and `db.wire.bind_complete_ms` distinguish its
phases. Request bytes count the frames submitted, including Sync when Parse is
rejected, rather than counting a Bind that was never sent.
First data can now be ParseComplete, before execution;
ReadyForQuery remains the completion boundary. A Parse error sends only Sync.
Interruption while waiting for Parse discards Bind/Execute and drains with Sync,
so a late acknowledgment cannot execute an abandoned statement. TCP peer tests
cover both paths and reuse of the connection after each.

`db.wire.clock = date-now` identifies the clock. In Cloudflare, it advances on
I/O; these fields cannot measure CPU-only work. Use native invocation CPU time
alongside them. A write callback means the local stream accepted the write, not
that the origin received it. A first-message delay still combines transport,
Hyperdrive scheduling, and origin work. These fields alone do not prove which
remote component delayed a query.

A timer probe is not an independent clock. The Worker runtime can clamp
`Date.now()` to the scheduled timeout, so timer counts and zero reported delay
alone cannot rule out delayed scheduling. In a staging investigation, correlate
heartbeat receipt times from a separate request or observer. Validate that probe
with a known wait, and keep deliberate lock controls separate from unforced stalls.

`db.wire.first_data_ms` measures when JavaScript receives its first socket chunk,
before the protocol parser runs. `db.wire.first_data_bytes` records only that
chunk's size. `db.wire.first_message_type` records the first decoded message's
protocol tag. Early raw data followed by a late decoded message identifies a
framing/dispatch interval; a late raw callback leaves remote delay and delayed
Worker scheduling unresolved. Raw data can include asynchronous server messages.
This is not a kernel receive timestamp or proof of network packet loss.
The active query consumer owns these callbacks; no per-query socket listeners
are added. Idle, streaming and multiplexed consumers have no new timing fields.

Multiplexed query pipelines and streaming cursors are outside this patch. The
Cloud product currently uses the default exclusive pool, with preparation off.
Fatal errors and cancellation still pass through the existing query machine.
A synthetic TCP peer holds the first response and then ReadyForQuery separately;
the test verifies these boundaries and checks that private values are absent.
The fragmented-response test sends an incomplete header first and verifies that
raw data precedes decoding. The old patch fails on the missing raw-data timing.

## Exact server correlation

Cloud's event telemetry also installs `Statement.CurrentTransformer`. Sampled
native SQL statements receive a leading SQLCommenter `traceparent` comment containing
only the statement's trace and span IDs. The hook preserves bound parameters.
Fixed-width hexadecimal validation prevents external trace context from adding
SQL syntax. Unsampled statements and invalid IDs receive no comment.
The prefix keeps the IDs inside `pg_stat_activity`'s usual 1,023 retained bytes,
even when the SQL is longer. It does not prevent an insights service from
collapsing high-cardinality tags; capture activity during a reproduction.

This lets a stage database observer match `pg_stat_activity` and blocking PIDs
to a specific Axiom SQL span, instead of inferring a match from timestamps or
query patterns. Server insights may sample or collapse tags; a missing sampled
execution does not prove the origin did no work. Transaction control and auth's
separate Kysely driver are not decorated by this hook.
An exact but late `query_start` also cannot exclude an earlier execution followed
by a transparent retry: another query can replace the earlier activity between
samples. Full statement history or provider retry records are needed to rule
that out.

The native-driver test checks actual Parse/Bind bytes for a statement longer than
1,023 bytes, its retained bound value, comment prefix and wire parent. The old
suffix fails the truncated-query assertion. All nine native-driver tests pass.
The Cloud SQL telemetry scenario checks delivered profile, inventory and resource
read spans through the real HTTP API and telemetry collector.

## Capture a recurrence

Run the committed scenario through the existing Alchemy deployment runner:

```sh
bun run e2e:deployed --database planetscale --test-name 'Cloud profile reads deliver exact SQL correlation and raw response timing'
```

The PlanetScale option retains Hyperdrive. Cloud fixtures use the UUID organization
IDs created by Cloud onboarding; shorter fixture IDs change the SQL frame size.
The Axiom adapter reads standard `db.query.text` separately from custom wire fields.

During a bounded reproduction, an origin observer with `pg_read_all_stats` can
sample this projection. Record the observer's send and receive timestamps too,
so comparisons account for network delay and different clocks:

```sql
select clock_timestamp() as observed_at, pid, backend_start, state,
       query_start, state_change, wait_event_type, wait_event,
       pg_blocking_pids(pid) as blockers,
       substring(query from 'traceparent=''([^'']+)''') as traceparent
from pg_stat_activity
where datname = current_database() and pid <> pg_backend_pid();
```

The comment identifies the SQL span, which is the wire span's parent. Preserve
sampling gaps and distinguish active, blocked and idle observations. An idle
backend with that exact comment has finished that statement at `state_change`.
Activity queried after the incident cannot recover its history. Hyperdrive's
sampled latency groups and database insights remain supporting evidence; they
do not identify an individual request. A deliberate lock validates correlation
but does not establish the cause of an unforced stall.
