# Product observability: know what's happening without watching

Goal: errors surface to us before users report them; churn/configuration
health is understandable passively. Dogfood Executor for all of it — the
monitoring automations live in this repo, call our own integrations through
the Executor MCP, and exercise the "write automations in an executor folder
with a generated TS SDK" roadmap.

## What exists today (audited 2026-06-12)

**Signal that is already flowing:**

- Worker traces → Axiom dataset `executor-cloud` (apps/cloud/src/observability/telemetry.ts).
  Browser spans join via traceparent (#981/#985).
- Error spans DO exist: ~6.7k ERROR-status spans in the last 7d
  (`http.server`, `executor.tool.execute` 804, `mcp.tool.dispatch` 211,
  `plugin.mcp.*`, `plugin.openapi.invoke` 72, …).
- Sentry: cloud browser (with replay + tunnel), desktop (3 processes).
  Worker-side capture only via explicit `captureCause` (no global init).
- PostHog: browser-only, cloud-only. The typed ~60-event product catalog is
  built on branch `claude/jovial-panini-ee23b0` (not merged).

**Proof the approach works — the SharePoint incident was in the data:**

```apl
['executor-cloud']
| where ['status.code'] == "ERROR" and name == "executor.tool.execute"
| extend msg = tostring(['status.message'])
```

shows `Missing required path parameter: drive-id/site-id/driveItem-id` on
`microsoft_graph…sitesGetDrives` / `sitesListDrives` / `drivesDriveItemSearch`
— 33 occurrences across 4 orgs, peaking 2026-06-09, days before the chat
where we debugged it. A daily digest would have caught it. Same window also
shows, unreported: `Stored refresh token could not be resolved.` ×75,
client-credentials token-exchange failures ×30, and `[object Object]` as a
status message ×22 (itself a bug — an error path that stringifies badly).

**Org attribution works today via trace join** (org id lives on the outer
`mcp.request` span, not the tool span):

```apl
['executor-cloud']
| where name == "mcp.request" and isnotnull(['attributes.custom']['mcp.auth.organization_id'])
| project trace_id, org = tostring(['attributes.custom']['mcp.auth.organization_id'])
| join kind=inner (
    ['executor-cloud']
    | where ['status.code'] == "ERROR" and name == "executor.tool.execute"
    | project trace_id, msg = substring(tostring(['status.message']),0,60)
  ) on trace_id
| summarize n=count() by org, msg | sort by n desc
```

## Gaps (in priority order)

1. **Expected tool failures are invisible to telemetry.** Upstream 4xx/5xx,
   `connection_rejected`, `oauth_connection_missing` become
   `ToolResult.fail(...)` in the Effect _success_ channel — no error span
   status, no Sentry, no log. The `plugin.openapi.invoke` span gets
   `http.status_code` stamped in code, but 0 of 19.5k spans in Axiom carry
   it (attribute set after span end? verify). These are exactly the
   "user is hitting a wall" signals.
2. **562/804 `executor.tool.execute` ERROR spans have an empty
   status.message** — the biggest error class is unlabeled.
3. **No org/user/integration attributes on tool spans** — attribution
   requires the trace join above; fine for digests, bad for Axiom monitors.
4. **No alerting exists anywhere.** No Axiom monitors, no scheduled checks,
   nothing in CI. All of the above fires into a dataset nobody reads.
5. **No server-side product analytics.** PostHog is browser-only, so
   MCP-driven usage (the actual product) is invisible to funnels/retention.
   Server-event seams already mapped in the PostHog session
   (ExecutionStackMiddleware, McpSessionStore.dispatch, the
   `executor.tool.execute` span).

## Plan

### Layer 0 — verify the pipes (observability of the observability)

The scariest failure mode is the signal silently going dark, in any of
these shapes:

- errors handled "gracefully" and returned to the client without any
  server-side record (the `ToolResult.fail` channel today);
- Sentry captures that never fire (worker has no global init — only
  explicit `captureCause` callsites);
- spans exported but missing the attributes you'd query
  (`http.status_code` stamped in code, present on 0/19.5k prod spans).

None of these page anyone, because the absence of data looks identical to
health. The countermeasure is contract tests on the telemetry itself, so
regressions fail CI instead of being discovered during the next incident:

- **Span contract tests (unit/integration):** drive a failing tool call
  through the engine with an in-process span collector and assert the
  exact spans + attributes + error statuses that Layer 1 promises. This is
  what would have caught the status_code-after-span-end bug.
- **Motel-backed e2e:** the `E2E_MOTEL=1` path already exports
  browser+server spans to local motel; add a scenario that triggers a tool
  failure and asserts the trace in motel contains the error span with org
  attribution. Pins the whole export pipeline, not just span creation.
- **Sentry emulator in `@executor-js/emulate`:** wire-level Sentry ingest
  emulator (envelope endpoint + request ledger), point the worker/browser
  DSN at it in e2e, assert "this user-visible error produced exactly one
  Sentry event". Same pattern as the WorkOS emulator.
- **Prod canary (deploy-to-verify):** after the Layer-1 fixes deploy, run a
  known-failing tool call against prod and confirm the error span lands in
  Axiom with the expected attributes. Rhys has explicitly OK'd deploying
  for this purpose (2026-06-12). A tiny scheduled "synthetic failure" canary
  org can keep verifying the pipeline continuously — if the canary's error
  spans stop appearing, THAT is the alert.

Robustness here is what makes Layers 2–3 cheap: if the data is trustworthy
and complete, the monitoring on top is a handful of queries instead of an
ongoing forensic project.

### Layer 1 — fix the telemetry at the source (small PRs, do first)

- Mark tool-failure outcomes on spans: when `invokeTool` returns
  `ToolResult.fail`, annotate the current span
  (`executor.tool.outcome = fail`, `executor.tool.error_code`,
  upstream status) and set error status for 5xx/auth-class failures.
- Fix empty + `[object Object]` status messages (normalize via the existing
  `formatInvocationCauseMessage` path).
- Stamp `organization_id` / `account_id` / `mcp.tool.integration` onto
  `executor.tool.execute` (values are already in AuthContext upstream).
- Merge the PostHog product-events branch; add the server-side event seam
  behind the same no-op-by-default pattern.

### Layer 2 — the `executor/` dogfood folder (the new thing)

Create a top-level `executor/` directory: automations written against our
own integrations through the Executor MCP, exercising the roadmap
(folder of TS automations + generated SDK + schedules) on ourselves first.

- `executor/automations/error-digest.ts` — daily: query Axiom for new/rising
  error signatures (group by error-class × integration × org, diff vs
  yesterday, call out first-seen signatures), post a digest. Would have
  caught SharePoint, the refresh-token cluster, and `[object Object]`.
- `executor/automations/connection-health.ts` — failing-connection report:
  orgs with repeated `oauth_refresh_failed` / `connection_rejected` (these
  users silently churn).
- `executor/automations/usage-pulse.ts` — weekly: PostHog + Axiom joined
  funnel/retention pulse (activation: spec added → connection working →
  first successful tool call; orgs gone quiet).
- Generated typed SDK for the connected integrations (axiom, posthog,
  planetscale, …) is the product feature this folder incubates; until the
  generator exists, automations call the MCP execute surface directly.
- Scheduling: GH Actions cron (or scheduled cloud agent) with an Executor
  API key; delivery channel TBD (Slack/email-via-Resend/GitHub issue).

### Layer 3 — the Windmill-style in-product view

Runs/activity console view: per-org recent invocations with outcome,
error class, drill-through to trace. The e2e runs-viewer work (#980) is the
in-house prior art; data needs are exactly the Layer-1 attributes. Design
after Layers 1–2 prove the queries.

## Proven access paths

- Axiom: `axiom_mcp.querydataset` (arg `apl`); error attrs live under
  `['attributes.custom']`, status under `['status.code']`/`['status.message']`.
- PostHog: `posthog_api` (org key) + `mcp_posthog_com` OAuth both connected.
- Prod DB: `planetscale_mcp` (organization/database/branch args).
