# Tool usage metrics

Self-host records authenticated `search`, `invoke`, `integrations`, and `skills`
MCP calls. Every repeated call counts, including validation errors and denied
invokes. This does not instrument tools called inside codemode `execute`, other
hosts, unauthenticated requests, or calls rejected before MCP tool dispatch.

Each event has the call-start timestamp in milliseconds, an HMAC-SHA256 member
pseudonym scoped to its organization, MCP tool name, canonical invoke target,
integration slug, traffic class, status, elapsed milliseconds, and response
bytes. Discovery calls have no target or integration. Malformed invoke targets
have neither. The address must contain identifiers and be at most 512 bytes.
The local pseudonymization salt persists in the metrics state table. Member
IDs, email addresses, session IDs, headers, arguments, results, and error text
are never stored. Keep the database within its existing private access boundary.

Response bytes count the complete serialized JSON-RPC response in UTF-8, before
HTTP/SSE framing or compression. Duration ends after transport send completes.
The fixed hidden-tool refusal is counted as `blocked`; this includes unknown
addresses because the existing response deliberately combines both cases.
Transport failures and abandoned calls count as `error` (zero response bytes
when no response was produced). Results and policies keep their existing behavior.

The observer uses public SDK transport callbacks. It does not inspect SDK
private fields or change search, schema, catalog refresh, or encrypted secrets.
PRs #17 and #18 and the refresh work for issue #8 can merge in either order.

The `executor_tool_usage` table shares the existing libSQL client with the
host. No second write connection opens. Writes run in batches once per second,
with at most 1,024 queued events and 1,024 active tracked calls per MCP session.
Retention runs at startup, each flush, and hourly while idle: seven days and
at most 100,000 rows. SQLite reuses deleted space; the table reaches a bounded
high-water size. A shutdown drains the queue. A crash can lose up to one second
of queued metrics; a busy or unavailable database can lose more. Queue overflow
and failed batches increment durable loss counters on the next successful
flush. An initialization failure disables metrics for that process and emits a
fixed warning. Never interpret a partial window as a complete historical rank.

Agents default to traffic class `agent`. Benchmarks and probes can send
`x-executor-traffic-class: benchmark` or `monitor`. Only these fixed values
survive; all other values become `agent`. This is a caller-supplied traffic
label, not an authenticated client identity.

Read the summary locally with database read permission:

```sh
bun run apps/host-selfhost/scripts/tool-usage-summary.ts \
  --db /path/to/executor.db \
  --from 2026-10-01T00:00:00Z --to 2026-10-08T00:00:00Z \
  --traffic agent --limit 20
```

The CLI opens SQLite read-only. It emits JSON with top tools and integrations ranked by calls,
status counts, nearest-rank p50/p95 duration, and total response bytes for the
half-open time window. It also reports retention limits, oldest/newest retained
timestamps, and cumulative loss counters. It omits member pseudonyms. The
default window is seven days; `--traffic all` includes probes. Integration ranks combine invoke targets by integration slug to rank adapters. Only retained events can be summarized.

Measure request overhead locally:

```sh
BENCH_SAMPLES=5000 bun run apps/host-selfhost/scripts/bench-tool-usage.ts
```

The benchmark compares warm real SDK calls with observation disabled/enabled,
using the same response sizes and HTTP-equivalent JSON serialization. It uses
a disposable WAL SQLite database, nearest-rank percentiles, and batches of 256.
Request latency excludes the background flush; amortized flush time is reported
separately. Small timing differences can include JIT and scheduling noise.
It does not measure network latency or production database contention.
