# Scheduled app implementation

Owner: current cron task. Rift: `.rifts/executor-next/scheduled-apps`.

Stack (create each layer before its work):

1. `schedules/authoring`: interval/calendar declarations referencing existing mutations; serializable discovery through the existing runtime inspection surface.
2. `schedules/engine`: persistent installed settings/runs, atomic claims, overdue coalescing, SDK operations and existing approval call/resume integration.
3. `schedules/hosts`: local/self-host scoped runner, native Alchemy cloud triggers, product authorization and management routes.
4. `schedules/ui`: shared schedule controls and Approvals page, authoring docs and real-server scenarios.

Approved: interval-first; UI/API enable/pause; all hosts; current deployment/accounts per new run; one active run per installed schedule; skip overlap; one overdue run; automatic approval by default; optional browser approval through existing SDK requests. Explicit denials still apply. No background elicitation, workflow checkpoints, or automatic mutation retries. Shared handler context is implemented in #152. A scheduled context that excludes interactive input at the type level remains deferred.

Implementation choices made visible: new schedules start paused; first run one interval after enabling. Pending approval occupies active slot. User confirmed the existing 15-minute approval expiry. Do not deploy or migrate any existing development/production database without explicit authorization. Fresh isolated test databases are the test harness's responsibility.

Account/source work is another active stack. Use public SDK seams, avoid assumptions about Deployment.files, and reconcile with current main before submission. Keep the skills stack separate.

## Progress

- Authoring is the bottom stack layer; full check passed.
- Engine adds schema 1.8.3 (schedules and scheduledRuns plus due/pending indexes). Existing resource data is unchanged; no live migration applied.
- Native Executor has a host-only `scheduler` lifecycle; it is not an HTTP group or Promise facade member. Products supply fresh authority and a concurrency gate for each dispatch.
- Settings discovery is split: `schedules.definitions` evaluates current authored declarations; `schedules.list` reads saved controls without app evaluation. Pausing existing work must succeed even if app code or account refresh is broken.
- Ordinary SDK approval records retain encrypted arguments; runs store metadata and a request ID. Browser responses queue the answer; runner alone resumes after current authorization.
- Native recovery marks incomplete runs interrupted only after the host guarantees the previous named runner stopped. No automatic replay of side effects.
- SDK controls, execution, overlap, approval and restart scenarios passed against real product servers.
- Hosts and shared UI are implemented. The browser enable/run/approve/pause flow passed against the actual local server. Claim revisions now guard stale dispatch and configuration writes. Removed definitions pause on next evaluation. Whole stack rebased on ee04cc0. Full check and all three SPA builds passed. Four local real-server scenarios and hosted permissions passed. Raw SDK review is rejected; browser reloads and queue acknowledgement are checked in the UI scenario. Draft stack is #145 → #146 → #147 → #148. Keep other source/skills stacks separate.

## Host validation

Local real-process scenarios now pass for automatic consent, explicit denial, unavailable elicitation, overlap exclusion, browser-only review, consume-once answering, overdue coalescing after process restart, and approval persistence through restart. Hosted self-host scenario passes current membership, member rejection, browser review, and blocking a demoted schedule creator.

Node runner starts only after HTTP routes are listening. Both hosts use a bounded execution pool (default 8, configurable via EXECUTOR_SCHEDULE_CONCURRENCY). Claims only occur after admission; full pools leave jobs persisted and due. Node checks each second. Cloud uses native Durable Object alarms plus a minute heartbeat, with Postgres as authority; event-scoped SQL clients are acquired inside the waitUntil scope. Cloud is typechecked, not live deployed.

## Shared context follow-up

The stack is adapted to merged #152: schedule handles retain their target
mutation context, app adaptation uses the shared requirements model, and examples
and real-server fixtures use standalone operations with `ctx.db`. Browser approval
policy, expiry, overlap and catch-up behavior are unchanged. Workflow PR #155 is
separate and unmerged; its schema 1.9.0 and `ctx.workflows` composition need to be
reconciled when these stacks integrate.

All four layers now include main at `4660c9d`. `bun run check`, all three
dashboard builds, four real local schedule scenarios (including browser and
restart), and the self-host scheduling scenario passed on September 20. Cloud
is typechecked only; no existing database migration or deployment was performed.
