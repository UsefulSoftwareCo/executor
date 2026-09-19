# Production database connections

Application traffic uses Hyperdrive, then PlanetScale's local transaction-mode
PgBouncer on port 6432. Deployment scripts use the direct endpoint on port 5432.
Code migrations hold session advisory locks, so they must bypass transaction pooling.

The connection budget is:

| Setting                                   | Value           |
| ----------------------------------------- | --------------- |
| PostgreSQL max_connections                | 50              |
| PostgreSQL superuser_reserved_connections | 3               |
| Local PgBouncer processes                 | 1               |
| PgBouncer default_pool_size               | 20              |
| PgBouncer max_db_connections              | 20              |
| PgBouncer max_client_conn                 | 400             |
| PgBouncer max_prepared_statements         | 200             |
| Hyperdrive origin connection limit        | 20 (soft limit) |

Hyperdrive's origin limit is advisory. PgBouncer's database limit enforces the
backend budget across users of one database. The cap is per PgBouncer process:
adding processes, databases, direct clients, or other poolers requires a new
aggregate budget. Keep capacity for provider sessions, deploys and administration.
The 20-connection application budget leaves 27 ordinary slots for those clients
after the three superuser-reserved slots. This is a concurrency ceiling, not a
target for active queries; check CPU, queue waits and latency before raising it.
Prepared statements require protocol-level support to remain enabled in PgBouncer.

The migration and membership-readiness scripts retry only the initial `SELECT 1`
when PostgreSQL returns SQLSTATE `53300`. They make at most seven attempts, with
ten seconds between attempts and a ten-second connection timeout. They never
retry migration bodies or readiness mutations. Other errors fail immediately.

The Database capacity workflow checks direct access and aggregate connection
headroom every five minutes. It fails when fewer than ten ordinary slots remain.
Counts include the monitor and conservatively count privileged client sessions
against ordinary capacity. GitHub schedule delays and notification preferences
apply; this is not a real-time paging service. Check PlanetScale CPU and PgBouncer
waiting clients alongside Cloudflare query errors and latency during load spikes.

For a routing change, first account for overlapping old and new pools. Verify
the active PostgreSQL limit and applied pool settings before changing Hyperdrive.
Afterward, check an authenticated application page, direct database access,
backend counts, and provider errors. Roll back by restoring the prior Hyperdrive
origin port only while there is capacity for both pools. Do not kill idle sessions
as routine maintenance: clients can reconnect and consume the slots again.
