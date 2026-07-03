# Open Agents — Architecture Foundations Design

Status: v3 (v2 post adversarial review; v3 platform-alignment pass — Eve 0.18.2 +
Vercel Workflow/Queues capabilities verified, see §8 changelog and
`tmp/briefings/{eve-queueing,vercel-workflow-queues}.md`)
Date: 2026-07-02
Author: Dana + Claude (conductor); current-state facts from scout briefings in
`tmp/briefings/`; reviews in `tmp/reviews/{codex,opus}-review.md`.

## 1. Why

The Eve/Vercel Services migration got the app to "workable." Everything is currently
single-user-shaped: `sessions.user_id` equality is the only authorization primitive,
Slack threads bind to one linked user, org scope is a hardcoded string with no
membership behind it, and there is no collaborative surface. Before layering more
features, we set the foundations: a principal/scope model everything else nests under,
and a server-authoritative event pipeline that multiple humans can attach to.

**Design principles (bind every section below):**
1. **Happy paths excellent; rare paths merely safe.** This is a collaboration tool,
   not banking or medical software. Live streaming UX, first-token latency, and
   editor feel get engineering attention; crash recovery gets *correctness*, not
   urgency machinery.
2. **Arrival order of *new* messages does not matter; recorded history is
   immutable and totally ordered.** Two halves, don't conflate them:
   - *Admission:* LLM turns are semantically robust to reordered
     near-simultaneous messages — an agent reads "1. Do A" / "2. Don't do 1"
     correctly in either arrival order, like a human would. So: no FIFO
     guarantees, no ordering locks on the send path. Concurrency handling =
     idempotency + retry, nothing stronger.
   - *Record:* the moment Eve records events, their order is final. Eve's stream
     indices are the total order; `eve_chat_events` preserves them exactly
     (`PK(chat_id, stream_index)`, append-only); nothing ever rewrites, reorders,
     or compacts persisted transcript. This is also a performance invariant: the
     conversation is the model's prompt prefix — mutating history busts provider
     prefix caching on every subsequent turn, on top of corrupting the record.
3. **Prefer platform primitives, verified against installed versions.** Eve 0.18.2
   and Vercel Workflow already provide durable turn execution, replayable streams,
   client reconnect-by-index, hooks, and unlimited sleeps — we build only the
   chat-domain layer both platforms explicitly leave to the app.
4. **Optimize for maintainability and extension** — fewer mechanisms, reused
   in-repo patterns (`automation_message_queue`, approval-timeout workflows) over
   novel ones.

## 2. Target features

1. **Permissions & nesting** — org, group, and user scopes for sessions, chats, skills,
   agents, tools, docs, automations.
2. **Multiplayer / shareable sessions** — start personal, upgrade to group/org; multiple
   humans view + participate live. (Sharing unit is the *session/workspace*, not the
   chat — see §4.2e.)
3. **Slack channel groups** — channel-initiated chats are visible to a group derived
   from the channel's membership, kept in sync.
4. **Multiplayer docs** — TipTap/Yjs Notion-like design docs with comments,
   agent-readable and agent-writable. *(Lifted out of foundations into its own
   initiative — §4.4 records the decisions made so far.)*
5. **Router agent** — ingress triage (esp. Slack) that hands off to the right
   library agent while preserving context.
6. **Automation pipelines** — trace-mining agents that spawn implementation sessions
   opening PRs, then QA/review agents on those PRs.

## 3. Current state (verified)

Full detail in `tmp/briefings/{data-model,eve-runtime,web-ui,platform-research,automations}.md`.
The load-bearing facts:

**Identity & ownership**
- Better Auth (`apps/open-agents/lib/auth/config.ts`) with Drizzle adapter; tables
  `users`, `accounts`, `auth_sessions`, `verification`. Providers: Vercel + GitHub,
  trusted account linking. **No org/team/group/membership tables exist.**
- `sessions.user_id` (NOT NULL FK) is the root of all ownership. `chats` →
  `session_id`; `eve_chat_session_states`/`eve_chat_events` → `chat_id`;
  `shares.chat_id` (public read-only link); `chat_reads(user_id, chat_id)`.
- `agent_library_items(user_id, scope_kind user|org, scope_id, kind agent|skill,
  item_id, item_json)`. Org scope is the string `OPEN_AGENTS_ORG_SCOPE_ID` (default
  `'default'`) — no membership check. **Hole: any authenticated user can write
  org-scoped agents/skills** via `/api/settings/agent-library`.
- **Hole (found in review): Slack thread impersonation.**
  `getOrCreateOpenAgentsSlackSession` returns an existing `slack_thread_sessions` row
  *before* resolving the current message author (`open-agents-slack-session.ts:341-349`);
  the link check only runs for new threads. Any Slack user who can post in an existing
  thread drives the thread creator's session and sandbox as that user.
- Route authorization is centralized in
  `apps/open-agents/app/api/sessions/_lib/session-context.ts`
  (`requireOwnedSession`, `requireOwnedSessionChat`,
  `requireOwnedSessionWithSandboxGuard`) — all `userId` equality. Pages gate in
  layouts + the session chat page. No middleware file exists.
- Two code paths bypass Drizzle with raw `postgres` (`max: 1` pools, 10s idle
  timeout): `agent/lib/open-agents-profile.ts` and
  `agent/lib/open-agents-slack-session.ts` (the Eve service side). This is a
  deliberate bundle boundary: the Eve agent build externalizes `postgres` and does
  not import the Next app's module graph (Drizzle client, `@/app` types).
- The web send path does **not** transmit an actor identity to Eve:
  `openAgentsEveHeaders()` sends only session/chat/tool-profile headers
  (`eve-send-payload.ts:42-53`). Slack sends `x-open-agents-user-id`, but it is the
  *stored thread creator*, not the current author.

**Eve runtime**
- Single root agent (`agent/agent.ts`). DB-backed "agents" are dynamic
  tools/instructions resolved at `session.started` from `agent_library_items`
  (`agent/tools/open_agents_profile.ts`, `agent/instructions/open_agents_profile.ts`).
  Per Eve's types, **dynamic tool resolvers also run at `turn.started` and
  `step.started`; instructions at `session.started` and `turn.started`** — the current
  code just happens to only use `session.started`.
- The profile resolver is viewer-keyed and creator-guarded: it returns `null` when
  the requesting user ≠ `sessions.user_id` (`open-agents-profile.ts:185`) and
  resolves agents/skills against the *requester's* user scope
  (`databaseScopesForRead(userId)`, lines 130-135) — both break for any non-creator
  participant.
- Eve multi-agent primitives (installed 0.18.2): built-in `agent` self-copy tool;
  declared subagents under `agent/subagents/<id>` (own tools/instructions, exposed to
  parent as tools, depth ≤3); `defineRemoteAgent`. **Channels are root-only**; there is
  no `defineRouter`/`defineHandoff`.
- Eve sessions: durable, replayable NDJSON stream at
  `/eve/v1/session/:sessionId/stream` (multi-reader attach OK, replay by
  `startIndex`); **one active continuation token** at a time — stale tokens are
  rejected (single-writer).
- **Eve turns are themselves durable workflows** (Vercel Workflow on Vercel):
  crash/timeout/redeploy mid-turn → the run resumes from the last completed step,
  and "every event is recorded before a step completes, so the whole stream is
  replayable" (`execution-model-and-durability.md`, `sessions-runs-and-streaming.md`).
  A dead app-side reader does **not** kill or lose the turn.
- The Eve client natively supports reconnect/replay: `ClientSession.stream({
  startIndex })` (auto-reconnects transient drops), `Client.session(state)` resume,
  channel-side `getSession(id).getEventStream({ startIndex })`. Eve's frontend guide
  explicitly recommends `stream({ startIndex: savedEvents.length })` for interrupted
  in-flight turns.
- **Eve has no send queue, by design**: "eve does not maintain a durable FIFO queue
  of user messages for a session… if bursts can arrive, keep your own per-session
  queue in the channel or app layer, then deliver the next message after the
  session parks again" (`execution-model-and-durability.md:53-61`). Mid-turn
  deliveries *may* be accepted and folded into the next turn, but only best-effort/
  timing-dependent. Competing continuation sends fail with internal
  `HookConflictError`/`NO_ACTIVE_SESSION`; the **public** error surface is just
  `ClientError(status, body)` — no stable stale-token error code to branch on.
- **No retention SLA on Eve's stream**: replay is backed by the configured Workflow
  world; Vercel Workflow managed persistence retains runs **7 days post-completion
  on Pro** (30 Enterprise). Eve's own docs tell DB-backed chat apps to persist
  stream events under their own chat id — `eve_chat_events` must remain the durable
  transcript.
- Web chat persistence is **client-driven**: the browser streams from Eve and POSTs
  each event to `/api/sessions/:id/chats/:id/eve` (`use-session-chat-runtime.ts`).
- Slack persistence is server-driven raw SQL, and it is the most durable path in the
  codebase: it persists the pending cursor (new continuation token + sessionId)
  **immediately after `send()`, before consuming any events**
  (`open-agents-slack-session.ts:452-457`), then persists each event as it streams.
- Automations send via `lib/chat/eve-runtime.ts` `runEveChatMessageTurn()` — a
  server-side send+persist path, **but it lacks the Slack cursor-first write**: its
  first DB write happens only when the first stream event arrives
  (`eve-runtime.ts:161-187`). Kill the function after `send()` and before event 0 and
  the continuation token is lost. (v1 of this doc claimed otherwise; review caught it.)
- So the codebase has **three** parallel persistence implementations: browser (web),
  raw SQL (Slack), and eve-runtime.ts (automations) — with *different* durability
  properties.
- Eve hooks (`agent/hooks/`) subscribe to runtime stream events *after durable
  recording*, server-side — currently unused by us.

**Slack**
- `slack_user_links(user_id ⟷ slack_team_id+slack_user_id)` with a **unique index on
  `user_id`** — one Slack identity per user, total, which blocks multi-workspace
  linking. `slack_thread_sessions(team, channel, thread_ts → session_id, chat_id,
  user_id)`. Unlinked Slack users are rejected *for new threads only* (see
  impersonation hole above).

**Automations** (full detail: `tmp/briefings/automations.md`)
- A real event-driven engine already exists: `automation_events` (normalized bus,
  deduped on `(source, scope_kind, scope_id, dedupe_key)`) → router workflow matches
  enabled definitions → `automation_runs` executed as **Vercel Workflow functions**
  with policy snapshots, attempts, timeline, artifacts, approvals (with workflow-hook
  resume + timeout), correlations (correlation_key → session/chat), outbox, and
  `automation_message_queue`, which serializes sends into busy chats.
- Trigger kinds: `event`, `schedule`, `poll`, `manual`. Sources: scheduler cron
  (`/api/automations/scheduler`, CRON_SECRET), GitHub webhook (emits
  `pull_request.*` etc. with installation→user scope), Linear webhook + ensured
  Linear-polling automation, per-automation public webhooks, authenticated manual
  events.
- Actions: `startSession`, `messageSession`, `runFunction` (Executor), `emitEvent`
  (**chaining already works** — child events re-enter the router), `notify`,
  `monitor`. Autonomy policy tiers `read-only|repo-edit|branch-pr|production` filter
  tools; `production` always requires before-run approval — **`branch-pr` (which
  opens PRs via `autoPr`) does not**. Sandboxes use a single shared
  `OPEN_AGENTS_GITHUB_TOKEN`.
- `automation_events.scope_kind` is a **separate enum** from
  `automation_definitions.scope_kind`; neither has `group`/`org` today, and the event
  enum, parsers, matchers, dedupe indexes, and route conditions must all migrate
  together.
- Known gaps: no outbox drain worker (non-webhook `notify` rows sit pending); no
  `telemetry` table (trace mining = `eve_chat_events` + `automation_timeline_events`
  + `usage_events`); automation scope/ownership is user-forced on save.

**Platform constraints**
- Vercel: WebSockets work on Fluid compute but pin to an instance and die at function
  max duration (300–800s); no native Next.js upgrade — `@vercel/functions
  experimental_upgradeWebSocket`. Durable presence/pubsub must live in Redis.
- Vercel Workflow (already in-repo: `workflow@5.0.0-beta.26`, automation runs,
  typed hooks, approval-timeout child workflows): unlimited run duration and
  `sleep()`, durable steps (bounded individually by function limits), hooks
  resumable by token, run streams reconnectable by `startIndex`. `after()`/
  `waitUntil()` extend work only to the function's own max duration — not a durable
  drain primitive.
- **Vercel Queues: at-least-once, approximate order, "no FIFO guarantee, even with
  a single consumer and max concurrency 1"** — a durable ingress bus, not a
  serializer (moot for us; ordering is a non-goal by principle #2).
- `resumable-stream` + AI SDK `useChat` resume: Redis-backed replay of an *active*
  UI stream; still requires app persistence for transcript/active-stream mapping.
  A live-tail optimization at most, not a substitute for the Postgres event log.
- `WorkflowAgent` (@ai-sdk/workflow): durable agent loop for apps running the AI
  SDK loop themselves — **not applicable**: Eve *is* our agent runtime and already
  runs turns on Vercel Workflow internally.
- Postgres access is `max: 1` pools with short idle timeouts throughout —
  **LISTEN/NOTIFY is not viable here** (needs dedicated long-lived connections;
  pooled/serverless front-ends often drop it entirely).
- TipTap: Collaboration (Yjs) is open; **Comments extension is paid Pro**. Hocuspocus
  is the OSS Yjs websocket server (Node/Bun; Redis scaling; webhooks).
- Yjs/Postgres: append binary updates per doc, periodically compact into snapshots
  with state vectors (y-postgresql pattern).
- Slack `conversations.members`: paginated, needs `channels:read` (public) /
  `groups:read` (private); membership deltas via `member_joined_channel` /
  `member_left_channel` events (delivery not guaranteed).

## 4. Design

### 4.1 Principals & scopes (the foundation everything nests under)

**Model.** Three principal kinds; every shareable resource carries exactly one scope:

```
scope_kind ∈ {user, group, org}    scope_id → users.id | groups.id | organizations.id
```

Access = membership at or above the scope:
- `user:U` → only U. (No org-admin break-glass inside `canAccess` — see below.)
- `group:G` → members of G, plus admins of G's org.
- `org:O` → members of O.

**Tables.** All **hand-rolled** (both reviewers independently converged here: the
Better Auth organization plugin's defaults — any-user org creation, session
`activeOrganizationId` columns, its own id generation, owner/admin/member roles to
reconcile against group roles — are integration work, not a drop-in, for a product
that is one `goaugment` org today):

```sql
organizations(id, slug unique, name, created_by, timestamps)
organization_members(org_id FK, user_id FK, role enum('admin','member'),
                     added_by, timestamps, PK(org_id, user_id))
groups(id, org_id FK, name, source enum('manual','slack_channel'),
       slack_team_id?, slack_channel_id?, created_by, timestamps,
       unique(org_id, slack_team_id, slack_channel_id) where source='slack_channel')
group_members(group_id FK, user_id FK, role enum('member','manager'),
              source enum('manual','slack_sync'), added_by, timestamps,
              PK(group_id, user_id))
```

**Product decision (Dana): single-org internal tool — multi-org is a non-goal.**
The schema stays multi-org-*shaped* only because it costs nothing; no code path
needs to handle a user in two orgs. To be explicit about what "dropping the plugin"
means: **Better Auth core stays** — it's what does OAuth login today (Vercel +
GitHub social providers) and is untouched. We skipped only the *organization
plugin* (org tables/invitations/active-org state), which the hand-rolled tables
replace. Future nicety: add **Slack as a Better Auth sign-in provider**, which
auto-creates `slack_user_links` at login — OAuth-linked-by-default (§4.3).

**Scope columns.** Add `(scope_kind, scope_id)` to: `sessions` (backfill
`user`/`user_id`), `docs` (new), `agent_library_items` (extend enum with `group`),
`automation_definitions` **and `automation_events` and every parser/matcher/dedupe
index/store path that reads their scope enums** (they are separate enums today —
migrate as one canonical shared type). `sessions.user_id` stays as **created_by**
(audit + default owner). **Chats default to their session's scope, with an
optional per-chat scope override** (`chats.scope_kind/scope_id`, nullable → inherit).
Sharing a chat shares *that transcript*; sibling chats stay private. The honest
caveat — the sandbox is session-level, so a shared chat's agent works in the same
workspace as private sibling chats — is **disclosed in the share dialog, not
treated as disqualifying**: this is a single-org internal tool among trusted
colleagues (principle #1), not a tenant boundary. `canAccessChat` = chat's
effective scope (override ?? session), and the profile resolver resolves
agents/skills against that same effective scope. The public `shares` link
(read-only, redacted) is unchanged.

**Permission verbs.** Not a single coarse `write` bit — review showed that routes
"send a chat message" and "edit the org's agent library" through the same bit
re-creates the org-write hole under a new name. Four verbs:

| verb | grants | who |
|---|---|---|
| `read` | view sessions/chats/docs/library/automations in scope | any member of scope |
| `write` | send messages, edit doc content | any member of scope |
| `manage` | create/edit/delete library items & automations at that scope | group managers, org admins (user scope: the user) |
| `admin` | re-scope, archive, delete, membership, shares | resource creator, group managers, org admins |

Per-resource ACLs are deliberately deferred — they compose later as an additional
grant source inside `canAccess` without touching call sites.

**Break-glass** is *not* a `canAccess` rule. `user:U` resources are readable by U
only. If org-admin emergency access is ever needed, it's a separate audited grant
table (actor, reason, expiry, logged) — explicit policy, not a parenthetical, and it
sidesteps the multi-org "which org's admins?" ambiguity since user scopes carry no
org anchor.

**Authorization module.** New `packages/open-agents/authz`. **Hard constraint: raw
`postgres` only — zero Drizzle, zero Next/`server-only`, zero `@/app` imports** — so
it is importable by both the Next app and the Eve agent bundle, which deliberately
excludes the app module graph. This is a design decision, not a spike outcome; the
packaging spike (§6.1) validates the build wiring, not the constraint.

```ts
type Actor =                       // who is acting — not always a web user
  | { kind: 'user'; userId: string }
  | { kind: 'slack'; teamId: string; slackUserId: string }   // §4.3 anonymous
  | { kind: 'service'; automationId: string }                // §4.6 automations

resolveMembership(actor): { orgIds, groupIds, adminOrgIds, managerGroupIds }
canAccess(actor, {scopeKind, scopeId}, verb: 'read'|'write'|'manage'|'admin'): boolean
requireSessionAccess(actor, sessionId, verb)   // replaces requireOwnedSession*
requireChatAccess(actor, chatId, verb)         // chat override ?? session scope
```

Slack actors resolve org membership through `slack_workspace_links` (workspace →
org) and group membership through live channel membership; they never get `manage`
or `admin`.

Caching: request-local memoization always; cross-request cache TTL **≤60s** and
explicitly invalidated on every membership mutation (group join/leave, org
add/remove, Slack sync deltas). Long-lived reads (SSE reconnect, doc tokens)
re-check on attach, never on a stale grant.

**Callers migrate as follows:**
- `session-context.ts` helpers keep their call-site API but delegate to authz. Every
  `userId === session.userId` check in routes migrates to `requireSessionAccess`
  (the web-ui briefing has the exhaustive route list).
- `agent/lib/open-agents-profile.ts` needs **two distinct changes** (review: this is
  the code path multiplayer actually runs through, and one line under-sells it):
  1. The ownership guard (`session.userId !== userId → null`, line 185) becomes
     `canAccess(actorId, session.scope, 'write')`.
  2. Agent/skill resolution re-keys from the *viewer's* scope chain
     (`databaseScopesForRead(userId)`) to the **session's** scope chain:
     creator's user scope ∪ the session's group/org. A group member must resolve the
     same agent the creator configured, not their own.
- **Actor identity becomes a first-class transmitted field.** The server send route
  passes the authenticated actor id to Eve (extend `openAgentsEveHeaders` with
  `x-open-agents-user-id` = actor); Slack passes the *re-resolved current author*
  (see §4.3), never the stored thread creator. Automations pass a typed service
  principal id. `sessions.user_id` is ownership metadata; the header is who is
  acting.

**Phase 0 security fixes (ship first, independent of everything else):**
1. Org-scoped writes to `/api/settings/agent-library` require org admin;
   group-scoped writes require group manager or org admin (`manage` verb).
2. Slack thread impersonation: re-resolve the Slack author on **every** message,
   not only at thread creation. Unlinked authors are **not rejected** — they act as
   their own Slack principal (`slack:{team}:{user}`, §4.3) with org-default access.
   What ends is silently running as the thread creator.

**Migration.** Create org `goaugment` and **decide the org id at migration time as
an invariant**: backfill `agent_library_items` rows from `'default'` to the real
generated org id in the same migration (atomic), and remove the
`OPEN_AGENTS_ORG_SCOPE_ID` env indirection. Backfill all users as org members,
`sessions.scope_kind='user', scope_id=user_id`. Multi-org capable schema, single-org
product for now.

### 4.2 Server-authoritative chat pipeline → multiplayer

Today there are **three divergent persistence paths** (browser-driven for web,
raw-SQL server loop for Slack, `lib/chat/eve-runtime.ts` for automations).
Multiplayer requires the server to own the event log. We canonicalize
`runEveChatMessageTurn()` — but review established that as-is it is *less* durable
than the Slack loop and unsafe under concurrency, so canonicalization means
**hardening it first**, in a neutral package, then converging callers onto it.

**Framing that resolves the durability question:** Eve's stream is itself durable
and replayable by `(sessionId, startIndex)`. Therefore `eve_chat_events` is a
**repairable projection** of Eve's stream, not the primary record of the turn. The
two invariants that make it repairable:

1. **Cursor-first write** — persist `{sessionId, continuationToken, streamIndex}`
   immediately after `send()` returns, before consuming any event (the Slack pattern,
   `open-agents-slack-session.ts:452-457`, copied into the canonical runtime).
2. **Idempotent append** — event writes are keyed by `PK(chat_id, stream_index)`
   upsert, so any actor can re-drain from Eve's stream at the persisted cursor
   without duplication.

Given those, a function dying mid-turn (Vercel max duration, deploy, crash) loses
nothing: **the Eve turn itself keeps running** (turns are durable workflows — §3),
events keep recording in Eve's replayable stream, and the projection catches up via
the *native* `ClientSession.stream({ startIndex })` reconnect API — no hand-rolled
stream attach. The projection must catch up within Vercel Workflow's retention
window (7 days Pro), which the watchdog below satisfies by minutes-scale margin.

**a) One send+persist core, in a neutral package.** The Eve send + cursor +
event-persistence core moves out of `apps/open-agents/lib/chat/eve-runtime.ts` into
`packages/open-agents/chat-runtime` — same import constraint as authz: raw
`postgres`, no Drizzle, no `@/app` types (web's `WebAgentUIMessage` conversion and
message projection stay in the app layer). This is what lets Slack (agent bundle)
and web (Next app) share one implementation without crossing the bundle boundary.

**b) Concurrent sends: no lock — idempotency + queue-on-conflict.** v1 had a
TOCTOU busy-check; v2 fixed it with a CAS claim protocol; v3 deletes the lock
entirely, because **ordering is a non-goal** (principle #2) and Eve already
enforces the only invariant that matters: one continuation owner, competing sends
rejected. Design:

- Each client send carries a **client-generated message id** (idempotency key —
  dedupes client retries, nothing more).
- Happy path: latest event is a turn boundary → `send()` → done. No claim, no
  `turn_seq`.
- Conflict path (turn already running, or two sends race and one loses at Eve —
  surfaces as `ClientError`; there is no stable public stale-token code, so any
  send failure while a turn is provably active is treated the same): the message
  drops into the **chat message queue** — the existing
  `automation_message_queue`/`claimNextAutomationQueuedMessage` machinery
  generalized to all senders (`chat_message_queue`). Whoever finishes the current
  drain claims queued messages at the park boundary and sends them — the
  **deliver-after-park** pattern Eve's docs prescribe verbatim, already proven
  in-repo by `automationMessageQueueWorkflow`. Multiple queued messages may fold
  into one turn; arrival order is whatever it is. **Once delivered and recorded,
  order is frozen** (principle #2): queue flexibility exists only *before* a
  message enters the stream — never reorder or rewrite what Eve has recorded.
- Sender UX: the message renders optimistically as "sending" either way; the user
  never sees the race. No 409s surfaced for the normal case — queued is a success.

**c) Draining: inline for latency, watchdog workflow for durability.**
`POST /api/sessions/:id/chats/:id/messages` → `requireSessionAccess(write)` →
`send()` → **cursor-first write** → `202 {sessionId, streamIndex}` → the same
invocation drains the stream inline (persist each event, idempotent upsert) —
fastest path from model token to Postgres to viewers' SSE. Durability does not
depend on that invocation surviving:

- Alongside the cursor-first write, start a **per-turn watchdog workflow**
  (`chatTurnWatchdogWorkflow(chatId, sessionId, startIndex)`) — the exact pattern
  of the in-repo `automationApprovalTimeoutWorkflow`: `sleep()` past the sender's
  max duration; wake; if the projection hasn't reached a turn boundary, finish the
  drain itself in looped durable steps (each step: `stream({ startIndex: cursor })`
  → persist a bounded chunk → checkpoint cursor; steps are individually
  function-bounded, the workflow is not). On boundary: claim + deliver queued
  messages (b), then exit.
- The SSE read path (d) additionally backfills opportunistically if it observes the
  projection lagging a live turn — a UX nicety (viewers catch up fast), not the
  correctness mechanism.
- The scheduler cron keeps a defense-in-depth scan for chats with unfinished turns
  and no live watchdog (workflow start failed) — expected to fire ~never.

This removes the "one uninterrupted serverless invocation per agent turn"
requirement using only primitives already proven in this repo, and keeps the happy
path a plain route with zero extra moving parts in the request path except one
workflow `start()`. *(The Eve hook (`agent/hooks/`, post-durable, server-side)
remains a possible future persistence writer for sender-less sessions. Not needed:
the watchdog covers sender death, and Eve's durable stream covers the gap window.
Revisit, don't reject.)*

**d) Fan-out read path.** `GET /api/sessions/:id/chats/:id/stream?from=<index>`:
`requireSessionAccess(read)` on attach and on every reconnect → SSE that replays
`eve_chat_events` from `from`, then tails. **Decision: cursor polling, not
LISTEN/NOTIFY** — the `max: 1` short-idle pools and pooled/serverless Postgres
front-ends make LISTEN unsound here (both reviewers, independently). Poll
`stream_index > cursor` at ~1s with jitter while the chat has an active claim, back
off to slow poll when idle; SSE connections are short-lived by design (function
duration boundary) and clients reconnect with their cursor — lossless via replay.
When Redis lands for presence, event notification moves to Redis pub/sub and the
poll becomes the fallback. Every participant, including the sender, renders from
this one stream; optimistic local echo of your own pending message is pure UI.

**e) Turn-taking & presence.** Single active turn per chat is Eve's invariant; our
job is only the UX around it: others see "X is running a turn" + their sends queue
transparently (b). Presence (who's viewing/typing) via Redis keys with TTL, exposed
on the stream as synthetic *app-level* events (not written into `eve_chat_events` —
that table stays pure Eve protocol; see §4.5 on markers).

**f) Sharing UX — two levels, both honest.**
- **Share chat** (the primary multiplayer verb): sets the chat's scope override
  (§4.1). Group/org members see and participate in *this* conversation; sibling
  chats stay private. Dialog includes one plain-language line: "collaborators'
  turns run in this session's shared workspace (repos/files)."
- **Share session/workspace**: upgrades the session scope — every chat + sandbox
  becomes group/org-visible. Dialog preflights the list of chats and connected
  repos. Requires `admin`.
`/sessions` and chat lists become "mine + shared with my groups/orgs" with filters.
Public link share unchanged.

**g) Web cutover is sequenced, not flag-dayed.** The server send route + SSE ship
while the old browser persistence endpoint stays up; active client-driven turns
drain (they complete within a session lifetime); then browser persistence is
removed. This is removal sequencing so accepted Eve turns aren't stranded mid-flight
— not a compatibility bridge that lives on.

**h) Slack convergence is its own later step — not Phase 1.** The raw-SQL Slack loop
is the *most battle-tested* path in production; replacing it is high-blast-radius
and gains nothing until the canonical runtime has proven the durability story under
real traffic. Once `packages/open-agents/chat-runtime` is stable in production for
web + automations, `runOpenAgentsSlackTurn` drops its bespoke loop behind a flag and
keeps only Slack-specific concerns (author re-resolution, thread reply extraction).
End state: one persistence implementation. Interim: two, deliberately.

### 4.3 Slack channel groups

- **Schema first:** migrate `slack_user_links` — drop the unique index on `user_id`
  (it blocks multi-workspace linking), add `slack_enterprise_id?`, uniqueness on the
  external identity `(slack_team_id, slack_user_id)`. Add
  `slack_workspace_links(slack_team_id PK, org_id FK, installed_by, timestamps)` —
  an org admin connects the workspace (we already hold bot tokens).
- Channel-initiated session (not DM): ensure `groups` row
  `(org, source='slack_channel', team, channel)` exists (name = `#channel-name`),
  then create the session with `scope=group:G`. DMs stay `user`-scoped. Existing
  `slack_thread_sessions` are **grandfathered as user-scoped** (their creators can
  upgrade scope manually); only new channel threads get groups — no retroactive
  exposure of old threads.
- **Author resolution on every message** (Phase 0 fix, restated): the Slack handler
  resolves the current author per message and attributes the turn to *them* —
  never the thread creator.
- **Anonymous Slack participation (product decision):** membership in the Slack
  workspace is sufficient trust — they're in the org and Slack has authed them.
  Unlinked authors act as a **Slack principal** `slack:{team_id}:{user_id}`: a
  typed actor the authz module understands alongside user/service principals. It
  resolves **org-scoped agents, skills, and tools** (not personal libraries, no
  `manage`), participates read/write in the channel's group sessions by virtue of
  channel membership, and its turns are attributed to the Slack identity in
  `usage_events` and the transcript. When the person later links (or signs in with
  Slack once that provider lands — §4.1), the principal's history merges onto their
  user via the `slack_user_links` row. No link-walls in the channel flow.
- **Membership sync:** on group creation, pull `conversations.members` (paginate,
  ≤200/page), intersect with `slack_user_links`, insert `group_members
  (source='slack_sync')`. Deltas via `member_joined_channel`/`member_left_channel`
  on the existing Slack handler. Reconcile cadence is **tiered by sensitivity**:
  public channels daily; **private channels every few minutes plus
  verify-on-access** — Slack event delivery isn't guaranteed, and a missed
  `member_left_channel` + daily sweep + membership cache would leak a private
  channel's sessions to a removed member for up to a day. With the ≤60s authz cache
  TTL and re-check-on-SSE-reconnect (§4.1), revocation takes effect within minutes.
- When a user links their Slack identity later, run a targeted sync for that user
  across tracked channels (lazy repair, not global rescan).

### 4.4 Multiplayer docs — lifted out of foundations

Review verdict, accepted: this is a self-contained product initiative (TipTap + Yjs
+ collaboration host + custom persistence + own comments) whose only coupling to the
foundations is the authz module and the `docs` scope columns. Keeping it in the
critical path inflates "foundations" and drags a websocket-hosting rabbit hole into
it. It moves to its own design doc after Phases 0–1. **Decisions already made, so
they aren't relitigated there:**

- `docs(scope_kind, scope_id, …)` columns and authz verbs ship in Phase 0 with
  everything else; the feature builds on them later.
- **Collaboration host: always-on Hocuspocus service from day one.** The
  Hocuspocus-on-Vercel-Fluid idea is dead — instance pinning, function-duration
  socket death, and Hocuspocus's expectation of owning its server lifecycle make it
  a spike that fails slowly. (Both reviewers, independently.)
- **All doc mutations — including agent tools — route through the collaboration
  service** that owns the live Y.Doc; direct Postgres update/snapshot writes are for
  compaction only (a direct DB write is durable but invisible to connected clients).
- Comments are **ours, not @tiptap-pro** (paid): a mark + sidebar over a
  `doc_comments` table, anchored by Yjs RelativePosition serialized via
  `Y.relativePositionToJSON`; comments whose anchor resolves to null are marked
  *outdated*, never dropped.
- Agent write tools prefer `append_doc` / comment over section replacement;
  `write_doc_section` needs a semantic-clobber policy (Yjs merges cleanly; meaning
  doesn't).
- Storage: y-postgresql pattern (append `doc_updates`, compact into `doc_snapshots`
  + state vectors, `markdown_cache` derived projection for agents/search).

### 4.5 Router agent & handoffs

Channels are root-only in Eve, so **the root agent is the router** — an
instruction/profile posture, not new machinery. Review corrected three things in
v1's sketch: agent state was at the wrong granularity, the handoff didn't actually
answer the routed message, and the tool wouldn't surface through the hardcoded
allowlists. Design:

- New reserved library agent `router` (org-scoped, seeded): terse triage
  instructions; its dynamic instructions enumerate the scope-visible agent library
  (name, description) so the catalog is always current.
- **Active agent lives at chat granularity**: `chats.agent_name` (nullable override,
  falls back to the session default). `sessions.agent_name` was session-global —
  one participant's handoff would silently re-agent every chat and every participant
  in the session, and concurrent handoffs would race on one column. The profile
  resolver keys on the chat (the send path already transmits
  `x-open-agents-chat-id`).
- **`handoff_to_agent({slug, brief})` is a first-class built-in tool**, added to the
  canonical Open Agents tool definitions, profile allowlists, automation policy
  filters, and UI editors (it will not appear via the library path — tool selection
  is hardcoded to the built-in set in `definitions.ts` / `open-agents-profile.ts` /
  `open_agents_profile.ts`). Policy: available to the router profile by default;
  other agents opt in.
- **Handoff semantics — the routed message gets answered.** Re-resolution at
  `turn.started` (mechanically confirmed in Eve's types) only affects the *next*
  turn, so a bare profile swap would leave the user's first message consumed by the
  router and never processed by the target. The tool therefore: validates the slug
  against the session scope's chain → `UPDATE chats SET agent_name=$slug` →
  **enqueues a synthetic follow-up turn** carrying the original message + brief
  (through the §4.2b chat message queue, delivered at the park boundary when the
  router's turn reaches `session.waiting`). The target agent's turn then runs with its tools +
  instructions, same Eve session, full history — a context-preserving handoff that
  actually does the work. *(Rejected alternative: routing before the Eve turn starts
  — requires an out-of-band classifier call duplicating context Eve already has;
  in-band triage + synthetic continuation keeps one model pipeline.)*
- **No synthetic events in `eve_chat_events`.** That table is typed as Eve protocol
  events and consumed by Eve's reducer; app-level markers ("handed off to X") would
  break or be dropped by projection. The handoff is visible naturally as the tool
  call + result in the stream; if richer UI affordances are wanted, they read from a
  separate `chat_annotations` table merged at projection time (same channel presence
  events use, §4.2e).
- Slack channel ingress: new sessions default `agent_name='router'`
  (env-overridable); first turn triages + hands off. **When triage is genuinely
  ambiguous, the router asks with a native Slack select** — Eve's Slack channel
  already renders HITL prompts as buttons/selects, so an agent-picker form in
  Slack is free (the router's `input.requested` lists candidate agents; the choice
  feeds the handoff). Web "New chat": explicit agent picker first (a picker is
  already on screen), router as the default/fallback choice.
- Heavier isolation (different model, restricted tools, parallel fan-out) comes
  later via declared Eve subagents (`agent/subagents/<id>`), which lower to tools —
  the router can then *delegate* (subagent call, results return to router) in
  addition to *handing off* (profile swap). Two verbs, both useful; v1 ships handoff
  only.

### 4.6 Automations → agentic pipelines

The engine already exists (bus → router → workflow runs → actions, with approvals,
chaining via `emitEvent`, correlations, autonomy tiers, `autoCommit`/`autoPr`). What's
missing is scope-awareness, internal event sources, trace access, and delivery
plumbing. Review added two hard requirements: the internal event source must ship
*with* loop prevention (it is otherwise an unbounded spend loop), and the service
principal must not launder privileges through the shared GitHub bot token.

1. **Scopes & service principal:** add `group`/`org` across **both** scope enums
   (`automation_definitions` *and* `automation_events`) and every parser, matcher,
   dedupe index, scheduler, webhook emitter, `emitEvent`, condition helper, and UI
   filter that touches them — one canonical scope type, migrated together (a
   definition-only migration strands group events unrepresentable). Replace
   `canReadAutomation`/`canWriteAutomation` internals with `authz.canAccess`
   (`manage` verb for authoring, per §4.1). Runs execute as a **typed service
   principal bound to the automation's scope** — sessions/chats they create carry
   that scope; the principal id is transmitted as the actor (§4.1) and attributed in
   `usage_events` for budget caps.
2. **GitHub credential scoping:** automation-driven repo writes/PRs use a
   per-installation token bound to what the *automation author* is entitled to (the
   GitHub webhook path already maps installation→user), **not** the shared
   `OPEN_AGENTS_GITHUB_TOKEN` — otherwise any group member who can author an
   automation can open PRs beyond their own GitHub permissions. Cross-repo or
   cross-scope `branch-pr` requires approval, not only `production`.
3. **Internal event source — ships only with loop prevention.** The canonical send
   path (§4.2) emits `chat.turn_completed`, `chat.turn_failed`,
   `session.lifecycle_changed` onto `automation_events` after persistence. Naively,
   an automation matching `chat.turn_completed` that sends a message completes a
   turn that emits `chat.turn_completed` — an infinite loop with model + sandbox
   spend attached, and per-turn dedupe keys don't stop it. Guards, landing in the
   same change:
   - every event carries a **causal chain id** (root event id) and **depth**;
     automation-originated turns propagate it; the router refuses to match an
     automation already present in the chain and enforces a global depth cap;
   - internal-event triggers are **opt-in with a mandatory subject filter** — no
     wildcard `chat.turn_completed` subscriptions;
   - per-automation execution rate limits;
   - dedupe keys for internal events are derived from `(chat_id,
     boundary_stream_index)` so workflow retries and projection re-drains (§4.2c)
     emit exactly once.
4. **Trace mining:** read-only SQL views over `eve_chat_events` +
   `automation_timeline_events` + `usage_events`, scope-filtered through authz,
   exposed as a `query_traces` tool (Executor `runFunction` or Eve dynamic tool) to
   miner agents. Miners emit `finding` artifacts + events.
5. **Pipeline template (the target loop):** miner automation (schedule trigger) →
   `finding` artifact + `emitEvent` → approval → `startSession` with
   `agent_name='implementer'`, `autonomy='branch-pr'`, `autoPr=true` → PR opens →
   existing GitHub webhook emits `pull_request.opened` → QA automation
   (`startSession` w/ PR checkout, run tests, comment) and review automation trigger
   on it, correlated by `correlation_key`. Every arrow already has a mechanism; we
   ship library agent definitions (miner/implementer/qa/reviewer) + seeded
   automation templates.
6. **Plumbing debts to close while we're in there:** an outbox drain worker
   (non-webhook `notify` is currently write-only), and Slack as a first-class notify
   destination (post run summaries/approvals into the originating channel's thread —
   pairs naturally with §4.3 channel groups).

### 4.7 What gets deleted/simplified

- Browser-side Eve event persistence queue (`use-session-chat-runtime.ts`) — after
  the drain window (§4.2g).
- Raw-SQL persistence loop in `agent/lib/open-agents-slack-session.ts` — in the
  flagged Slack-convergence step (§4.2h), not Phase 1.
- Hardcoded `OPEN_AGENTS_ORG_SCOPE_ID` scope probing in `open-agents-profile.ts`
  and the env indirection itself (org id becomes a migration invariant).
- Per-route ad-hoc `userId ===` checks (delegate to authz).
- Treat as clay: no compatibility shims. The two deliberate interim states —
  browser-persistence drain window and pre-convergence Slack loop — are removal
  *sequencing* with an end date, not bridges.

## 5. Delivery phases

| Phase | Ships | Depends on |
|---|---|---|
| **0. Authz foundation + security fixes** | org/group tables, scope columns + backfill (both automation enums), `packages/open-agents/authz` (raw-postgres), helper swap, actor-identity header, org-write hole fix, Slack author re-resolution fix | — |
| **1. Server-authoritative chat (web + automations)** | `packages/open-agents/chat-runtime` (cursor-first + idempotent append via native `stream({startIndex})`), `chat_message_queue` generalization + deliver-after-park, send route (202 + inline drain), per-turn watchdog workflow, SSE poll fan-out, share-session UI, browser-persistence drain then removal | 0 |
| **2. Slack convergence** | flagged swap of the Slack raw-SQL loop onto chat-runtime | 1 proven in prod |
| **3. Slack channel groups** | slack_user_links migration, workspace→org link, channel groups, tiered membership sync | 0 (2 not required) |
| **4. Router & handoff** | `chats.agent_name`, router agent, `handoff_to_agent` built-in + allowlists, synthetic follow-up dispatch, turn-started re-resolution, Slack default | 0, 1 (queue) |
| **5. Automation pipelines** | scope migration (defs+events), service principal + GitHub credential scoping, internal events **with loop guards**, trace views, miner→PR→QA templates, outbox drain | 0, 1, 4 |
| *(separate initiative)* **Docs** | own design doc; builds on authz + docs scope columns; decisions pre-made in §4.4 | 0, 1 |

Phases 3 and 4 are mutually independent after 0+1 and can run as parallel worker
slices; 2 gates only on 1's production soak, not on 3/4.

## 6. Spikes / verification before Phase 1

1. **Packaging (decides Phase 1 shape, do first):** `packages/open-agents/{authz,chat-runtime}`
   imported by both the Next app and the Eve agent bundle — validate build wiring
   both directions with the raw-postgres-only constraint. (The constraint is
   decided; the spike proves the toolchain.)
2. **Watchdog recovery:** kill a send function mid-turn after the cursor-first
   write; verify the Eve turn keeps running, the watchdog workflow finishes the
   drain via `stream({ startIndex })` with no duplicates (idempotent append), and
   queued messages deliver at the park boundary.
3. **Send race behavior:** two concurrent sends from two instances — one reaches
   Eve, the other's `ClientError` lands it in the queue, both messages are
   eventually processed (any order), no 500 surfaces to either client, client-id
   idempotency dedupes a retry storm.
4. Dynamic re-resolution at `turn.started`: confirm instructions + tools both
   refresh, keyed on `chats.agent_name`; measure per-turn overhead.
5. SSE-on-Vercel behavior at function duration boundary (client cursor reconnect,
   authz re-check on attach).
6. Synthetic follow-up dispatch: handoff tool → `session.waiting` → queued turn runs
   under the writer claim with the target profile.

## 7. Decisions & remaining open questions

**Resolved (Dana, 2026-07-02):**
1. **No multi-org** — internal single-org tool; schema stays multi-org-shaped only
   because it's free. Better Auth core (OAuth login) unaffected; org *plugin*
   skipped. Sign-in-with-Slack provider is a future auto-linking nicety.
2. **Group/org members get `write`** on shared sessions/chats — attribution via
   per-turn actor id + `usage_events`; caps later if ever needed.
3. **Chat-level sharing is in** — per-chat scope override (§4.1, §4.2f); the
   session-level sandbox overlap is disclosed, not disqualifying, among trusted
   org colleagues.
4. **Unlinked Slack users participate anonymously** as Slack principals with
   org-default agents/tools (§4.3) — no link-walls; linking merges history.
5. **Router placement:** Slack ingress = router default (with native Slack select
   picker when ambiguous); web = explicit picker with router as fallback option.

**Still open (none block Phases 0–1):**
1. Docs review/approval flows — deferred wholly to the docs initiative doc.
2. Slack principal → user history merge semantics on link (re-attribute
   `usage_events` and transcript attribution rows, or just associate
   going-forward?) — decide during Phase 3; going-forward is the cheap default.

## 8. Review changelog

### v3 product decisions (Dana)

§7 questions closed: no multi-org; group write yes; **chat-level sharing accepted**
(reverses the v2 review-driven rejection — the confidentiality frame assumed tenant
boundaries this product doesn't have; per-chat scope override with disclosed
sandbox overlap); **anonymous Slack participation** (replaces v1's link-wall and
reframes the impersonation fix from "reject unlinked" to "attribute to Slack
principal"); Slack-native agent picker via Eve HITL selects; principle #2 sharpened
— arrival-order-agnostic *admission* only, recorded history immutable/append-only
(prefix-cache + integrity invariant).

### v2 → v3 (platform-alignment pass)

Prompted by Dana's challenge: "are we reinventing wheels Vercel/Eve already ship?"
Two scouts verified installed Eve 0.18.2 docs/types and July-2026 Vercel platform
state (`tmp/briefings/{eve-queueing,vercel-workflow-queues}.md`). Plus a governing
product ruling: **message ordering does not matter for LLM turns** (design
principle #2) — happy-path UX and maintainability outrank rare-path rigor.

**Hand-rolled → platform-native:**
- Stream re-attach: hand-rolled NDJSON attach → native `ClientSession.stream({
  startIndex })` (Eve's documented reconnect API for interrupted turns).
- Sweeper cron → per-turn watchdog workflow (unlimited `sleep()`, in-repo
  approval-timeout pattern); cron demoted to defense-in-depth.
- Durability reasoning corrected in our favor: Eve turns are durable workflows —
  sender death never kills or loses a turn; the projection just catches up.

**Machinery deleted (ordering non-goal + Eve is the arbiter):**
- v2's `turn_seq` CAS claim protocol, claim expiry, and 409-first UX — replaced by
  client-message-id idempotency + queue-on-conflict + deliver-after-park.

**Hand-rolled parts confirmed as correct (platforms explicitly punt):**
- The per-chat message queue: Eve docs *instruct* apps to keep their own queue and
  deliver after park; Vercel Queues guarantees no FIFO even single-consumer (and we
  don't need FIFO anyway — the queue is a parking lot, not an orderer). We
  generalize the in-repo `automation_message_queue`, we don't build anew.
- `eve_chat_events` as durable transcript: Eve has no retention SLA; Vercel
  Workflow retains 7 days post-completion (Pro). The Postgres log stays
  authoritative — now a verified fact, not an assumption.

**Evaluated, not adopted:** `WorkflowAgent` (wrong layer — Eve is our agent
runtime, itself Workflow-backed); `resumable-stream`/`useChat` resume (active-
stream replay only; possible later live-tail optimization); Vercel Queues as send
ingress (adds a hop, no benefit over direct route + queue table).

### v1 → v2 (adversarial review)

Two independent adversarial reviews (codex `review` preset, opus;
`tmp/reviews/`). Every blocker/major was verified against source before adoption.

**Accepted — both reviewers converged independently:**
- TOCTOU send race → turn-claim CAS + queue reuse (§4.2b). [opus B1 / codex #1]
- v1's claim that `runEveChatMessageTurn` "already encodes the Slack durability
  lesson" was **false** (verified: first write waits for event 0) → cursor-first
  write + idempotent append (§4.2). [opus B2 / codex #2]
- LISTEN/NOTIFY unsound on `max:1`/pooled Postgres → cursor polling now, Redis
  pub/sub later (§4.2d). [opus M5 / codex #9]
- Shared package vs Eve bundle boundary → raw-postgres-only constraint on
  `packages/open-agents/{authz,chat-runtime}` (§4.1, §4.2a). [opus M3 / codex #18]
- Better Auth org plugin dropped for hand-rolled tables (§4.1). [opus m3 / codex #17]
- Hocuspocus-on-Vercel dead; always-on host; docs lifted out of foundations
  (§4.4). [opus m5 + overbuild / codex #15, #16]
- Membership cache TTL/invalidation specified (§4.1). [opus m4 / codex notes]

**Accepted — single-reviewer findings, verified in source:**
- Profile resolver breaks for non-creator viewers; both the ownership guard *and*
  the viewer-keyed scope chain must change to session-scope keying (§4.1). [opus M2]
- Actor identity is never transmitted on the web path → first-class header (§4.1).
  [codex #3]
- **Slack thread impersonation hole** (existing prod bug) → Phase 0 fix (§4.1, §4.3).
  [codex #4]
- Handoff didn't answer the routed message → synthetic follow-up turn under the
  writer claim (§4.5). [codex #5]
- `agent_name` session-global → `chats.agent_name` (§4.5). [opus M6]
- `handoff_to_agent` blocked by hardcoded allowlists → first-class built-in (§4.5).
  [codex #13]  App markers don't belong in `eve_chat_events` (§4.5). [codex #14]
- Internal-event feedback loop → causal chain id, depth cap, opt-in subject filters,
  rate limits, boundary-derived dedupe — landing *with* the feature (§4.6.3).
  [opus M1 / codex notes]
- `automation_events` scope enum omitted from v1's migration (§4.1, §4.6.1).
  [codex #12]
- Shared GitHub bot token = PR privilege escalation → author-entitlement-scoped
  credentials (§4.6.2). [opus M8]
- Coarse write bit re-creates the library hole → four permission verbs (§4.1).
  [codex #6]  Break-glass out of `canAccess` (§4.1). [codex #7 / opus m7]
- "Share chat" is really "share session" → honest naming + preflight (§4.2f).
  [codex #8]
- Slack convergence out of Phase 1, flagged, after prod soak (§4.2h). [opus M4]
- Private-channel membership de-sync leak → tiered reconcile + verify-on-access
  (§4.3). [opus M7]
- `slack_user_links` unique-on-user blocks multi-workspace → migration (§4.3).
  [codex #11]
- Migration stranding (org id, old Slack threads, in-flight browser turns) →
  invariants + grandfathering + drain window (§4.1, §4.2g, §4.3). [codex #19 /
  opus m2]
- v1's hook/runtime self-contradiction + missing §4.2(b) → resolved: runtime-owned,
  hook documented as future alternative (§4.2c). [codex #20 / opus m1]

**Modified — reviewer's diagnosis accepted, different fix chosen:**
- Opus B2 prescribed adopting the Eve hook as the persistence writer. Chosen
  instead: the **repairable-projection** model (cursor-first + idempotent re-drain
  from Eve's replayable stream + repair-on-read + sweeper), which survives the same
  failure mode without moving chat-table writes into the agent bundle — aligned
  with codex #10's "split acceptance from draining." The hook stays on the table
  for sender-less sessions.
- Codex #5 prescribed "route before starting the Eve turn" as first option. Chosen:
  in-band triage + synthetic follow-up — an out-of-band classifier duplicates
  context Eve already has.

**Rejected / not adopted:**
- Nothing was rejected outright; opus's "the rejected Eve hook is the correct fix"
  framing was softened to "legitimate future alternative" per above — the reviewers
  themselves disagreed on this point, and the repairable-projection model
  satisfies both of their underlying requirements (survive sender death; don't
  block on one invocation).
