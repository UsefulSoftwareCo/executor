# Adversarial Review — Open Agents Architecture Foundations (DRAFT v1)

Reviewer posture: skeptical principal engineer. Verified design claims against source:
`agent/lib/open-agents-profile.ts`, `apps/open-agents/app/api/sessions/_lib/session-context.ts`,
`apps/open-agents/lib/chat/eve-runtime.ts`, `agent/lib/open-agents-slack-session.ts`,
`node_modules/eve/dist/src/shared/dynamic-tool-definition.d.ts`, plus the five briefings.

Bottom line up front: the diagnosis is right (single-user shape, three persistence paths, no
membership) and the *direction* is right. But the load-bearing plank — "canonicalize
`runEveChatMessageTurn()` as the server-authoritative log" — has an unaddressed cross-instance
concurrency race, a durability gap the design wrongly claims is already solved, and a
function-lifetime failure mode whose correct fix (the Eve hook) the design explicitly rejects.
§4.6's internal-event source is an un-throttled feedback-loop generator. Several §4.1 authz
changes are underspecified in exactly the raw-postgres Eve code where they matter most. §4.4
(docs/Yjs) is overbuilt for a "foundations" doc and should be lifted out.

---

## What the design got factually right (verified, so I'm not re-litigating these)

- **Dynamic re-resolution at `turn.started` is real.** `dynamic-tool-definition.d.ts:13`
  `DynamicToolEventName = "session.started" | "turn.started" | "step.started"`, and
  `ALLOWED_DYNAMIC_INSTRUCTION_EVENTS` (lines 15-22) is restricted to session/turn boundaries.
  So §4.5's handoff-by-`agent_name`-swap-then-re-resolve is mechanically supported. Good — this
  is the one place I expected the design to be lying and it isn't.
- **Single active continuation token / multi-reader stream** (eve-runtime briefing) — correct.
- **Three persistence paths exist** — confirmed: browser queue (`use-session-chat-runtime.ts`),
  raw SQL (`open-agents-slack-session.ts:465-486`), Drizzle (`eve-runtime.ts:161-187`).
- **Org-write hole is real.** `agent/lib/open-agents-profile.ts:79-81,130-135` probes
  `scope_kind='org', scope_id='default'` with no membership check; web-ui briefing confirms
  `/api/settings/agent-library` lets any authed user write `scope='org'`.

---

## BLOCKERS

### B1. Canonical send path has a cross-instance write race with no locking; the 409 busy-check is TOCTOU
**Element:** §4.2(a) web send → "busy check (latest event not a turn boundary → 409) →
`runEveChatMessageTurn()`"; §4.2(d) "single active turn."
**Evidence:** The busy check is a bare read-then-act with no lock. See the existing Slack
implementation the design wants to reuse: `open-agents-slack-session.ts:413-425` reads
`getLatestEveChatEvent` then later `send()`s — nothing between them serializes. The continuation
token lives in `eve_chat_session_states.state.continuationToken` (`eve-runtime.ts:125,213-218`).
On Vercel there are N function instances; two simultaneous sends (two multiplayer users, or a
user + an automation `messageSession`) both read the same boundary event, both read the same
continuation token, both call `session.send()`. Eve rejects the stale token (sessions-and-
streaming: "stale tokens are rejected"), so one `send()` throws. In a Next route that surfaces as
a 500, not a graceful 409, and the losing user's message is dropped with no queue (queueing is
"explicitly deferred," §4.2(d)).
**Why blocker:** Multiplayer is target feature #2 and the *entire justification* for the refactor;
the design ships the exact concurrency it exists to enable with no concurrency control. This is
not an edge case — it's the happy path of "two humans participate live."
**Fix:** Make the send atomic. A Postgres advisory lock keyed on `chat_id`
(`pg_try_advisory_xact_lock(hashtext(chat_id))`) or an optimistic-concurrency guard on
`eve_chat_session_states` (compare-and-swap a `turn_seq`/`streaming` column, `UPDATE ... WHERE
turn_seq = $expected`) taken *before* `send()`. Loser returns a real 409. Note the automations
path already had to build `automation_message_queue` to serialize sends into busy chats
(automations briefing §Data Model) — that is the same problem, unsolved for the interactive path.
Reuse that serialization primitive rather than reinventing a racy check.

### B2. Server-owned persistence dies with the function; the rejected Eve hook is the correct fix
**Element:** §4.2(a) "the server to own the event log … we canonicalize `runEveChatMessageTurn()`";
§4.2 rejected-alternative block dismisses the Eve hook as "an unverified mechanism … when a proven
in-repo path already exists."
**Evidence:** `runEveChatMessageTurn` persists by iterating the stream *inside the caller's
function* (`eve-runtime.ts:90-93` → `createPersistedEveEvents` 161-187). §3/§4.2 also claim the
Slack durability lesson ("cursor persisted immediately after `send()`") is "already encoded here."
**It is not.** Slack does an explicit standalone cursor write *before* the event loop
(`open-agents-slack-session.ts:452-457`); `createPersistedEveEvents` does its first write only when
the first event arrives (`eve-runtime.ts:170-182`). If the function is killed after `send()` but
before event 0 — or, more importantly, at the Vercel duration cap (300–800s, platform briefing)
mid-turn — the continuation token and remaining events are never persisted, and **no other actor
resumes the stream**, because in the server-authoritative model the browser is no longer streaming
(§4.2 "the browser stops calling Eve directly … sheds its whole persistence queue"). The durable
log silently truncates for every viewer.
**Why blocker:** The current browser-driven model is actually *more* robust to this: the browser
is a long-lived streamer that reconnects. The refactor removes that safety net and replaces it
with a function whose lifetime is capped below the length of an autonomous coding turn. The Eve
hook (`agent/hooks/`, "subscribe to runtime stream events after the event is durably recorded",
hooks briefing) is precisely the mechanism that survives sender death because it runs in the Eve
runtime, not the app request. The design rejects the one option that solves its own worst failure
mode, on the grounds that it's "unverified" — but the proven path is proven only for
*automations*, which don't have interactive Vercel-route duration pressure the same way.
**Fix:** Either (a) adopt the Eve hook as the persistence writer (verify hook→`chat_id` mapping in
a spike — that's a day, not a quarter), or (b) if keeping `runEveChatMessageTurn`, run it *only*
inside a Vercel Workflow (not a plain route — the design leaves this "decide in spike," which is
too late; make it a decision), add the explicit post-`send()` cursor write Slack has, and specify a
resumable re-attach worker for turns that exceed one function lifetime. Do not delete the browser
persistence path (§4.7) until the replacement demonstrably survives a mid-turn function kill.

---

## MAJORS

### M1. Internal-event source (§4.6.2) is an unbounded feedback loop / cost bomb
**Element:** "the canonical send path emits `chat.turn_completed`, `chat.turn_failed`,
`session.lifecycle_changed` onto `automation_events` after persistence — chats become automatable
subjects with zero new infrastructure (the bus + router already handle dedupe/matching)."
**Evidence:** `emitEvent` chaining "already works — child events re-enter the router" (§3, automations
briefing §Actions). Event dedupe is on `(source, scope_kind, scope_id, dedupe_key)`
(`store.ts:emitAutomationEvent`, automations briefing). Every completed turn is a distinct event
with a distinct `dedupe_key`, so dedupe does not stop recurrence. An automation matching
`chat.turn_completed` whose action is `messageSession`/`startSession` sends a turn → completes →
emits `chat.turn_completed` → matches again → forever, fanning out sandbox spend and model spend.
Two such automations can ping-pong across chats. Nothing in the design bounds causal depth.
**Why major:** This is the explicit worry in the review brief and it's real: internal events
triggering automations that create chats that emit events. Ships an infinite loop with a credit
card attached.
**Fix:** Before emitting internal events: (1) tag automation-originated turns and *exclude* them
from re-emitting `chat.turn_completed` (or mark the event with a causal chain id and refuse to
match automations already in the chain); (2) add a per-automation execution rate limit and a
global causal-depth cap on `emitEvent`→run→`emitEvent` chains; (3) require internal-event triggers
to be opt-in with a mandatory `subject` filter, never wildcard. This must land *with* §4.6.2, not
after.

### M2. §4.1 authz migration breaks the Eve profile resolver for every non-creator viewer
**Element:** §4.1 "agent/lib/open-agents-profile.ts scope chain becomes: user:me → each of my
groups → my org(s)"; §4.2 group members "view + participate live."
**Evidence:** `open-agents-profile.ts:185` returns `null` when `userId && session.userId !==
userId`, and `getDatabaseAgent(agentName, userId)` (line 283) resolves the agent using the
*viewer's* user scope (`databaseScopesForRead(userId)`, lines 130-135). In a shared session a group
member's `userId` ≠ `session.userId` (creator), so today the resolver returns `null` → no tools, no
instructions → the agent is broken for that participant. Even after loosening the ownership guard,
agent lookup keyed on the *viewer's* user scope means a member won't resolve a `user`-scoped agent
that belongs to the creator. The correct key is the *session's* scope, not the caller's.
**Why major:** This is the exact code path multiplayer runs through, it lives in the raw-postgres
Eve service (not the app), and the design's one-line "scope chain becomes…" undersells that both
the ownership guard *and* the agent-resolution scope key must change, and must change to resolve
against the session's principal, not the requester's. Underspecified where it's hardest.
**Fix:** Resolver must (a) authorize via `canAccess(userId, session.scope, 'read')` instead of
`session.userId === userId`, and (b) resolve agent/skill items against `session.scope`'s chain
(creator's user scope ∪ session group/org), not the viewer's user scope. Spell this out; it's not a
find-and-replace of `userId ===`.

### M3. `packages/open-agents/authz` "importable by both" collides with the Eve bundle boundary
**Element:** §4.1 "New `packages/open-agents/authz` (importable by both the Next app and the Eve
agent code)."
**Evidence:** The Eve agent is a separate build with `build.externalDependencies: ["postgres"]`
(eve-runtime briefing) and its DB access is deliberately raw `postgres`, *not* Drizzle, precisely to
avoid app coupling (`open-agents-profile.ts:72-77`, `open-agents-slack-session.ts:75-80`; data-model
briefing "bypass Drizzle"). `runEveChatMessageTurn` itself imports `@/lib/db/client` (Drizzle),
`@/app/types`, and `@/lib/chat/*` (`eve-runtime.ts:10-15`) — app-side modules the agent bundle
can't cleanly pull in. The design's own spike #1 admits "does the shared code need to move to
`packages/`." So the two most important Phase-1 moves (shared authz, shared send path) both depend
on an unresolved packaging question.
**Why major:** Phase 1 is the linchpin (Phases 2,4,5 depend on it) and its feasibility rests on an
unspiked assumption that a Drizzle/Next-coupled module can be imported into a bundle that goes to
lengths to avoid exactly that.
**Fix:** Design the authz package as raw-`postgres`-only, zero Next/`server-only`/Drizzle imports,
so both sides can consume it. Do the packaging spike *before* committing Phase 1 scope, and move
`runEveChatMessageTurn`'s persistence core into that same neutral package or accept that Slack
convergence (below) can't happen in Phase 1.

### M4. Deleting the Slack raw-SQL path in Phase 1 risks live Slack threads, with no shim
**Element:** §4.2/§4.7 "`runOpenAgentsSlackTurn` drops its bespoke raw-SQL loop and calls the same
runtime"; §4.7 "Treat as clay: no compatibility shims; old paths are removed, not bridged."
**Evidence:** The Slack loop (`open-agents-slack-session.ts:403-502`) is the most battle-tested
persistence path (explicit cursor-first write, per-event persistence, boundary-derived status).
Replacing it in Phase 1 with `runEveChatMessageTurn`, which (M3) may not even be importable from the
agent bundle and (B2) lacks the cursor-first write, and doing so with no fallback, means a
regression breaks *live* Slack threads in production.
**Why major:** High-blast-radius change to the one path that already works, sequenced early, with a
stated no-shim policy.
**Fix:** Converge Slack *last*, behind a flag, after the interactive path has proven the durability
story. "No compatibility shims" is fine for greenfield UI; it is reckless for the Slack ingestion
loop. Reorder: Slack convergence moves out of Phase 1 into its own step after Phase 1 is stable.

### M5. SSE fan-out via LISTEN/NOTIFY is unsound on the current pooled/serverless Postgres setup
**Element:** §4.2(c) "SSE that replays … then tails (LISTEN/NOTIFY on insert, or 1s poll fallback)."
**Evidence:** The app's postgres clients are `max=1` pools with `idle_timeout=10`
(`open-agents-profile.ts:73-76`, `open-agents-slack-session.ts:76-79`; data-model briefing notes the
same for the Drizzle client). LISTEN requires a *dedicated, long-lived* connection per listener;
with `max=1` and 10s idle timeout that's incompatible, and many managed Postgres front-ends
(PgBouncer transaction pooling / serverless drivers) drop LISTEN/NOTIFY entirely. Combined with the
Vercel per-instance connection budget, one LISTEN connection per open SSE stream does not scale.
**Why major:** The "or 1s poll fallback" is buried as an alternative, but it is really the *only*
viable option in this environment, and 1s polling of `eve_chat_events` per viewer has its own cost
profile that should be designed, not hand-waved.
**Fix:** Drop LISTEN/NOTIFY for fan-out. Either poll `eve_chat_events` by `stream_index > cursor`
on a short interval, or route realtime through the Redis the design already mandates for presence
(§4.2(d)) — publish new-event notifications to a Redis channel from the persister and have SSE
readers subscribe there. Pick one in the design.

### M6. `agent_name` is session-global; handoff and multiplayer make it a shared mutable that races
**Element:** §4.5 "`handoff_to_agent`… `UPDATE sessions SET agent_name=slug`"; re-resolved at
`turn.started`.
**Evidence:** `agent_name` is a single column on `sessions` (`open-agents-profile.ts:179-183`),
inherited by all chats in the session (data-model briefing: "chats … scope is inherited through
sessions"). A handoff mutates the agent for the *whole session and all its chats and all
participants*, not just the current chat/turn. In a multiplayer session, or a session with multiple
chats, one user's handoff silently re-agents everyone else's next turn. Two concurrent handoffs
race on one column.
**Why major:** Turns target feature #5 (router/handoff) into a global side effect that fights target
feature #2 (multiplayer). The re-resolution mechanism works, but the *granularity* of the state it
reads is wrong.
**Fix:** Put the active agent at chat granularity (`chats.agent_name`, or a per-chat override that
falls back to session default), and have the resolver read the chat's agent, not the session's.
`handoff_to_agent` then scopes to the emitting chat. This also removes the concurrency on a single
session column.

### M7. Private Slack channel membership de-sync leaves a multi-hour access leak
**Element:** §4.3 membership sync via `member_left_channel` events "plus a daily reconcile sweep";
sessions are `scope=group:G` from private channels; authz `resolveMembership` is "cached."
**Evidence:** Group access derives from `group_members` synced from `conversations.members`. If the
`member_left_channel` event is missed/dropped (Slack does not guarantee delivery) the only backstop
is a *daily* reconcile. Add the cached `resolveMembership` (§4.1, TTL unspecified) and a removed
private-channel member can retain read access to the group's sessions — including sandbox side
effects and any private-channel-derived context — for up to 24h + cache TTL. For a *private*
channel that is a genuine confidentiality breach, not just staleness.
**Why major:** Privacy of private channels is called out in the brief; the design's own sync cadence
creates the leak.
**Fix:** For private-channel-derived groups, reconcile far more aggressively (minutes, or
event-driven with a short-TTL verify-on-access), bound `resolveMembership` cache TTL explicitly
(≤60s) and invalidate on membership-change events, and re-check membership on SSE
attach/reconnect rather than trusting a long-lived cached grant.

### M8. Service-principal automations + shared GitHub bot token = privilege escalation on PR creation
**Element:** §4.6.1 "Runs execute as a service principal bound to the automation's scope";
`branch-pr`/`autoPr` opens PRs.
**Evidence:** Sandboxes use a single shared `OPEN_AGENTS_GITHUB_TOKEN`
(`open-agents-slack-session.ts:518`). Autonomy `branch-pr` already opens PRs via `autoPr`
(automations briefing §Actions). Under §4.6, any group manager who can author a group-scoped
automation gets a service principal that opens PRs using the *shared bot token*, regardless of that
user's own GitHub permissions on the target repo. `production` requires approval, but `branch-pr`
(which opens PRs) does not.
**Why major:** A lower-privileged group member can cause repo writes/PRs they couldn't perform with
their own credentials, via an automation running as an over-broad service identity.
**Fix:** Bind automation GitHub actions to a per-installation/per-repo token scoped to what the
*author* is entitled to (the GitHub installation model already carries user scope — github webhook
maps installation→user, automations briefing), not the global bot token; require approval for
cross-repo or cross-scope `branch-pr`, not only `production`; attribute and budget-cap service-
principal runs.

---

## MINORS

### m1. §4.2 is missing subsection "b)"
Sections run a), c), d), e) — there is no b) (`architecture-foundations.md:203→227`). Either a
subsection (persist mechanism? turn lifecycle?) was cut and its content lost, or the list is
mislabeled. A reader can't tell if something is missing. Fix the enumeration and confirm nothing
dropped.

### m2. "Keep `'default'` as the org's stable id" fights Better Auth's id generation
§4.1 migration floats reusing the literal string `'default'` as the org id to avoid rewriting
`agent_library_items.scope_id`. The Better Auth organization plugin generates its own ids (nanoid,
per auth config in data-model briefing) and may reject/overwrite a hand-set `'default'`. Don't
couple a data-migration shortcut to a plugin whose id format you don't control; backfill the rows to
the real org id.

### m3. Better Auth organization plugin is overhead for a single-org product
§4.1 adopts the org plugin for "invitations, roles, active-org for free," then immediately notes the
product is single-org (`goaugment`) and provides a hand-rolled fallback. The plugin's active-
organization-in-session model adds wiring to every request for zero single-org benefit, and its
org-level roles (owner/admin/member) must still be reconciled with your separate group roles
(member/manager) inside `canAccess`. Given you're building `resolveMembership`/`canAccess` anyway,
the hand-rolled tables are *less* total complexity today. Recommend starting hand-rolled; adopt the
plugin only if/when multi-tenant invitations become a real requirement (Open Question #1).

### m4. `resolveMembership` cache invalidation is unspecified
§4.1 says "cached" with no TTL or invalidation trigger. Membership changes (group leave, org
removal, Slack `member_left_channel`) must promptly revoke. Tie into M7. Specify TTL + explicit
invalidation on membership mutation.

### m5. Hocuspocus-on-Vercel-Fluid is speculative; the fallback is the real plan
§4.4 deploys Hocuspocus first as a Vercel `experimental_upgradeWebSocket` route, then "lift to an
always-on host if churn hurts." Hocuspocus expects to own its ws server lifecycle; bolting its
`Server` onto Vercel's experimental upgrade primitive is unverified integration, and the platform
briefing is clear that reconnects don't hit the same instance and durable coordination must be
external. You already concede the always-on host is the fallback. Skip the speculative step: deploy
Hocuspocus on the always-on host from day one. Cheaper than a spike that likely fails.

### m6. `write_doc_section` semantic-clobber and comment-orphan handling under-specified
§4.4 agent tool `write_doc_section` replaces a section by anchor while humans edit concurrently.
Yjs merges without conflict but can produce semantic clobber (agent overwrites a paragraph a human
just rewrote). And `doc_comments.anchor` (Yjs RelativePosition) resolves to null when the anchored
range is deleted — orphan handling isn't described. Both need a defined policy (prefer `append_doc`;
mark orphaned comments "outdated" rather than dropping).

### m7. Break-glass org-admin read of `user`-scoped sessions is a broad grant, note it explicitly
§4.1 "user:U → only U (plus org admins for break-glass, logged)." That means org admins can read any
user's private chats and sandbox side effects. It's defensible, but it should be an explicit,
consent-visible policy (users should know a `user`-scoped session is admin-readable), not a
parenthetical. In a single-org internal tool this is probably fine; state it.

---

## Overbuild / scope judgment

- **Cut §4.4 (multiplayer docs) out of "foundations" entirely.** It is a self-contained product
  feature (TipTap + Yjs + Hocuspocus + custom Postgres persistence extension + own comments) that
  does not sit under the "principals + event pipeline" thesis the doc opens with (§1). It shares
  only the authz module. It's the largest lift with the least coupling to the actual foundation.
  Ship it as its own initiative after Phases 0–1; keeping it here inflates the "foundations"
  investment and invites the Hocuspocus/Vercel rabbit hole (m5) into the critical path.
- **§4.6 is mostly "already works, add scope."** Correct, and honestly scoped — but M1/M8 mean the
  two genuinely new pieces (internal event source, service principal) carry the two biggest new
  risks. Don't let "the engine already exists" hand-wave those two.
- **§4.5 (router) is right-sized** — it's a profile/instruction posture, not new machinery, and the
  mechanism checks out. Just fix granularity (M6).

## Underspecified to the point a team couldn't start

- Phase 1 concurrency control (B1) and persister-death recovery (B2) are the first things an
  implementer hits and neither is decided ("decide in spike," "revisit"). A team cannot start Phase
  1 without these resolved — they determine the whole shape of the send route.
- The authz package boundary (M3) must be decided before Phase 0/1, not discovered.

## What I'd cut or reorder

1. **Resolve B1, B2, M3 into the design before any Phase 1 work.** They're not spikes; they're
   architecture decisions the rest of Phase 1 hangs on.
2. **Move Slack convergence out of Phase 1** to a later, flagged step (M4).
3. **Lift §4.4 docs out of foundations** into a separate initiative (Overbuild).
4. **Start authz hand-rolled, not on the Better Auth org plugin** (m3).
5. **Land loop-prevention *with* §4.6.2, not after** (M1).
6. **Reconsider the Eve hook for persistence** rather than rejecting it — it's the natural answer to
   B2 and to the "persist even if no app server is watching" case you'll hit with long/automation
   turns.

---

## VERDICT

**Blockers (must fix before committing the refactor investment):**
- **B1** — Canonical send path: cross-instance write race, TOCTOU busy-check, dropped messages; no
  lock/serialization. Multiplayer ships the concurrency it exists to enable, unguarded.
- **B2** — Server-owned persistence dies with the Vercel function; the "Slack durability lesson" is
  *not* actually encoded in `runEveChatMessageTurn` (no cursor-first write); the rejected Eve hook
  is the correct fix for the exact failure mode.

**Majors:**
- **M1** — Internal-event source is an unbounded feedback loop / cost bomb (no depth cap, dedupe
  doesn't stop it).
- **M2** — Authz migration breaks the Eve profile resolver for non-creator viewers; agent lookup
  keyed on viewer scope, not session scope.
- **M3** — `packages/open-agents/authz` "importable by both" collides with the Eve bundle's
  deliberate no-Drizzle/no-Next boundary; unspiked and Phase-1-critical.
- **M4** — Deleting the proven Slack raw-SQL path in Phase 1 with a no-shim policy risks live Slack
  threads.
- **M5** — SSE fan-out via LISTEN/NOTIFY is unsound on `max=1`/serverless Postgres; poll or Redis is
  the only viable path.
- **M6** — `agent_name` is session-global; handoff + multiplayer make it a racing shared mutable.
  Move to chat granularity.
- **M7** — Private-channel membership de-sync + daily reconcile + cached membership = multi-hour
  confidentiality leak.
- **M8** — Service-principal automations + shared GitHub bot token = PR-creation privilege
  escalation; `branch-pr` opens PRs without approval.

**Minors:**
- **m1** — §4.2 missing subsection "b)".
- **m2** — Reusing literal `'default'` as org id fights Better Auth id generation.
- **m3** — Better Auth org plugin is net overhead for a single-org product; start hand-rolled.
- **m4** — `resolveMembership` cache TTL/invalidation unspecified.
- **m5** — Hocuspocus-on-Vercel-Fluid speculative; go straight to the always-on host.
- **m6** — `write_doc_section` semantic clobber and comment-orphan handling under-specified.
- **m7** — Break-glass org-admin read of user-scoped sessions should be explicit policy, not a
  parenthetical.

**Overbuild:** §4.4 (docs) does not belong in "foundations" — lift it out.
