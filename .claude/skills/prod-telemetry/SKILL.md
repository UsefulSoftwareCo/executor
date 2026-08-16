---
name: prod-telemetry
description: Query Executor's production telemetry — Axiom traces (executor-cloud dataset), prod Postgres via PlanetScale, PostHog product analytics — through the Executor MCP. Use when investigating prod errors, latency, usage, churn signals, or verifying a deploy's telemetry; includes the dataset field layout, working APL recipes, and the error-attribution join.
---

# Production telemetry access

All three stores are queryable through the Executor MCP's connected
integrations — no dashboards or credentials needed. Verify the connection
exists with `connections.list` if a call fails.

## Axiom traces (`axiom_mcp`)

Tool: `axiom_mcp.user.axiomMcpOAuth.querydataset` — the argument is `apl`
(NOT `query`). Dataset: `['executor-cloud']` (worker spans; browser spans
join the same traces via traceparent).

**Field layout (the part you'd otherwise rediscover by failed queries):**

- Custom span attributes live under the JSON map `['attributes.custom']`,
  NOT as top-level `attributes.*` columns. Read with
  `['attributes.custom']['mcp.tool.name']`. A nonexistent top-level field is
  a hard query error ("invalid field"), not an empty result.
- Span status: `['status.code']` (`"OK"`/`"ERROR"`), `['status.message']`.
- Exceptions: the `events` column carries `exception.type` /
  `exception.stacktrace` JSON.
- OTel basics are top-level: `name`, `trace_id`, `span_id`,
  `parent_span_id`, `duration`, `_time`.

**Span names worth querying** (and their custom attrs):

- `executor.tool.execute` — `mcp.tool.name` (full address), and since
  PR #992: `executor.tool.outcome` (`ok`/`fail`),
  `executor.tool.error_code`, `executor.tool.error_status`,
  `executor.tenant`, `executor.subject`.
- `mcp.tool.dispatch` — `mcp.tool.name` (sandbox path),
  `mcp.tool.integration`, same outcome attrs.
- `plugin.openapi.invoke` — `plugin.openapi.method` / `path_template` /
  `base_url`, and since PR #992 `http.status_code`.
- `executor.tools.list` — `executor.tools.filter.integration` / `.owner` /
  `.connection` (present only when the read was filtered),
  `executor.tools.result_count`, and the catalog-refresh counters
  `executor.tools.sync.candidates` (rows the stale scan returned) /
  `executor.tools.sync.synced` / `.incomplete` / `.failed` / `.lost_claim` /
  `.skipped_claimed` / `.skipped_backoff` / `.skipped_parked`. A slow tools
  read is almost always `candidates` > 0: subtract the child span durations to
  confirm.

  `candidates` is the one to alert on for scan cost: in steady state it is
  ZERO. Every trigger is cleared by the listing that answers it, drift marks
  included (`connection.tools_stale_token` is compare-and-set to NULL), so a
  scope whose `candidates` never returns to 0 has connections that are due and
  never resolving, not a busy fleet.

  The four terminal counters partition every attempt, and the distinction that
  matters when triaging is `incomplete` vs `failed`. `incomplete` is the PLUGIN
  reporting bad news correctly — a refused credential, an unreachable server,
  an unreadable spec — with the existing catalog kept and the retry ladder
  advanced. `failed` is the refresh raising or dying before reaching any
  verdict: the executor's own error channel, swallowed to keep the read
  answerable, and the thing to page on. A connection stuck permanently stale
  shows up as one or the other on every read for its scope; `failed` > 0 also
  emits the `executor tool catalog refresh failed` warning, which is its only
  other signal. `lost_claim` counts listings that completed and were then
  discarded because another attempt had re-claimed the connection — wasted
  upstream work that looks like success from every angle except the write.

  The three `skipped_*` counters are how the sync lifecycle reports its work
  avoidance, and they are the ones to watch after a rollout:
  `skipped_parked` counts connections whose credential was refused (an `auth`
  verdict) AND whose catalog is merely past its freshness window — the park
  gates re-verification only, so a never-synced connection with the same
  verdict reports `skipped_backoff` instead and keeps walking the ladder.
  `skipped_backoff` counts ones inside their failure ladder, and
  `skipped_claimed` counts refreshes another concurrent read had already taken.
  `synced` collapsing toward the skip counters is the intended shape — it means
  dead upstreams stopped costing handshakes. `skipped_claimed` rising with
  request concurrency for one integration is cross-isolate deduplication
  working.

- `executor.tools.sync` (child of the above, one per refreshed connection;
  older spans carry the previous name `executor.tools.sync_stale` and no
  trigger/outcome attrs) — `executor.integration`,
  `executor.connection`, `executor.tools.sync.trigger`
  (`cold`/`stale_marked`/`config_revised`/`expired`),
  `executor.tools.sync.claimed` (bool — false means another reader owned the
  refresh and this one did nothing) and `executor.tools.sync.outcome`
  (`synced`/`incomplete`/`lost_claim`/`fail`). Older spans report `ok` where a
  current one reports `synced` or `incomplete`; that rename is the same
  distinction as the counters above, so any query matching `outcome == "ok"`
  needs both spellings to span the change. `cold` split out of `stale_marked`
  when the drift mark became its own column: before that, a never-synced
  connection and one invalidated mid-invocation were the same row, so spans
  predating it report every never-synced connection as `stale_marked`. The
  matching warning log carries
  `integration`, `connection`, `trigger` and `errorTags` only: a refresh runs
  on a live credential, so no cause or upstream message is logged and Axiom
  will not have one to search.
- `mcp.request` (outer) — `mcp.auth.organization_id`,
  `mcp.auth.account_id`, `mcp.tool.name`, CF edge fields (`cf.country`…),
  MCP client fingerprint (`mcp.client.name`…).

**Recipe — error signatures by class (the daily-digest query):**

```apl
['executor-cloud']
| where _time > ago(1d)
| where ['status.code'] == "ERROR" and name == "executor.tool.execute"
| extend msg = substring(tostring(['status.message']), 0, 120)
| extend tool = tostring(['attributes.custom']['mcp.tool.name'])
| summarize n = count() by msg, tool
| sort by n desc
```

**Recipe — attribute errors to orgs.** Tool spans now carry
`executor.tenant` directly (post-#992). For spans from BEFORE that deploy,
join through the outer request span:

```apl
['executor-cloud']
| where name == "mcp.request" and isnotnull(['attributes.custom']['mcp.auth.organization_id'])
| project trace_id, org = tostring(['attributes.custom']['mcp.auth.organization_id'])
| join kind=inner (
    ['executor-cloud']
    | where ['status.code'] == "ERROR" and name == "executor.tool.execute"
    | project trace_id, msg = substring(tostring(['status.message']), 0, 60)
  ) on trace_id
| summarize n = count() by org, msg | sort by n desc
```

**Recipe — upstream failure rate per integration (post-#992 attrs):**

```apl
['executor-cloud']
| where _time > ago(1d) and name == "mcp.tool.dispatch"
| extend outcome = tostring(['attributes.custom']['executor.tool.outcome'])
| extend integration = tostring(['attributes.custom']['mcp.tool.integration'])
| where isnotnull(outcome)
| summarize calls = count(), fails = countif(outcome == "fail") by integration
| extend failRate = todouble(fails) / todouble(calls)
| sort by fails desc
```

**Known signal caveats** (audited 2026-06-12):

- Pre-#992 spans: `ToolResult.fail` outcomes (upstream 4xx/5xx, auth
  rejections) are INVISIBLE — they rode the Effect success channel with no
  span marker. Don't conclude "no errors" from old data.
- Many pre-#992 ERROR spans have an EMPTY `status.message` (tagged errors
  without a message field) — group those by `events` exception.type instead.
- `[object Object]` status messages are the pre-#992 formatting bug.

## Prod database (`planetscale_mcp`)

Read tool needs `{organization: "answer-overflow", database: "executor",
branch: "main"}`. It returns `ok: true` even when the SQL failed — check the
result text for `Error:`. Use for tenant/integration/connection facts that
spans don't carry (row sizes, config shapes, counts).

## Product analytics (`posthog_api` / `mcp_posthog_com`)

Browser-side events only (the ~60-event typed catalog, PR #987; server-side
events not built). The org-key `posthog_api` connection covers the REST API;
the OAuth MCP connection covers the higher-level tools.

## Verifying a deploy's telemetry (Layer-0 canary)

After deploying telemetry changes: run a known-failing tool call against
prod, then assert the expected attributes arrive in Axiom within ~1 min.
Absence of data looks identical to health — query for the NEW attribute
explicitly rather than eyeballing dashboards. The e2e equivalent runs on
every suite: `e2e/cloud/telemetry-contract.test.ts` via the `Telemetry`
service (motel `/api/spans/search?attr.<key>=<value>`).
