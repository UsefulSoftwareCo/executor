# Adversarial Design Review — `docs/architecture-foundations.md`

Verdict: the design is directionally aimed at the right foundations, but several core claims are contradicted by source and the proposed multiplayer/send/router foundations are not safe enough to build on yet. The blockers are mostly around Eve's single continuation token, identity/authorization semantics once `sessions.user_id` stops being ownership, and Slack writes.

## Findings

### 1. BLOCKER — `409 busy` is not a concurrency control for Eve sends

**Claim/design element:** §4.2 says web sends do `requireSessionAccess(write) → busy check (latest event not a turn boundary → 409)` and §4.2/§4.6 rely on a single active turn per chat.

**Evidence:** Eve documents that a session has exactly one active continuation token and stale tokens are rejected (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:12-15`). The current send paths only do a read-before-send check: Slack checks the latest event and then calls `send()` (`agent/lib/open-agents-slack-session.ts:413-425`), automations do the same (`apps/open-agents/lib/automation/actions.ts:351-358`), and `runEveChatMessageTurn()` reads the saved state and sends with no compare-and-swap or lock (`apps/open-agents/lib/chat/eve-runtime.ts:111-116`). The schema has a per-chat state row but no version/active-turn lock (`apps/open-agents/lib/db/schema.ts:206-227`). Two server instances can both observe a boundary event, read the same continuation token, and send concurrently.

**Fix/alternative:** Add a real per-chat single-writer primitive before Phase 1: a `chat_turn_locks`/`chat_active_turns` table with a conditional insert/update, a `pg_try_advisory_xact_lock(hash(chatId))`, or a state-row version CAS. Hold the claim through the `send()` call and pending cursor write. If the lock fails, return 409 or enqueue; do not rely on the event log as the lock.

### 2. BLOCKER — The proposed canonical runtime loses Slack's cursor durability guarantee

**Claim/design element:** §4.2 says `lib/chat/eve-runtime.ts` already persists the cursor immediately after `send()` and encodes the hard-won Slack lesson.

**Evidence:** Source contradicts this. `createEveChatTurnEvents()` calls `session.send()` and returns an async generator without writing the returned `continuationToken`/`sessionId` (`apps/open-agents/lib/chat/eve-runtime.ts:111-129`). The first persistence write happens only after the first stream event is received (`apps/open-agents/lib/chat/eve-runtime.ts:170-182`). Slack's bespoke loop is different: it builds a pending `SessionState` immediately after `send()` and persists it before iterating events (`agent/lib/open-agents-slack-session.ts:445-457`). Replacing Slack with the current runtime would regress crash/retry recovery if the process dies after Eve accepts the turn but before the first event is consumed.

**Fix/alternative:** Make the canonical runtime persist `{ sessionId, continuationToken, streamIndex: firstStreamIndex }` immediately after `send()` returns, then persist each event and finally the client/session state. Only then delete the Slack raw loop.

### 3. BLOCKER — Shared-session sends do not fit the current Eve identity/profile contract

**Claim/design element:** §4.1 says `sessions.user_id` becomes `created_by`, shared access is scope-based, and Eve agent code can use the same authz package. §4.2 moves web sends server-side. §4.5 expects the next turn to resolve the target agent's tools and prompt.

**Evidence:** The current Eve profile resolver treats the Eve auth subject as the owner and rejects the session if it differs from `sessions.user_id` (`agent/lib/open-agents-profile.ts:173-186`, called at `agent/lib/open-agents-profile.ts:279-283`). The proposed web/automation runtime does not even send `x-open-agents-user-id`; `openAgentsEveHeaders()` only sets session/chat/tool-profile headers (`apps/open-agents/lib/chat/eve-send-payload.ts:42-53`, `151-165`). Slack does send `x-open-agents-user-id`, but it sends the stored thread/session user (`agent/lib/open-agents-slack-session.ts:435-439`). Once a group member who is not the creator sends a turn, the resolver either sees no real actor or sees an actor that fails the `session.userId` equality check.

**Fix/alternative:** Split actor identity from resource ownership. The authenticated server send route should pass a trusted actor id, and Eve-side profile resolution should call `requireSessionAccess(actorId, sessionId, 'write')` instead of comparing to `created_by`. Agent/tool/skill resolution should be based on the session scope plus actor-specific grants, not `sessions.user_id`. Define service-principal identity as either a real bot user with scoped membership or a separate typed principal that authz understands.

### 4. BLOCKER — Existing Slack threads allow unlinked users to write as the original user

**Claim/design element:** §4.3 says v1 keeps the link requirement for writes while unlinked channel members only lack web access.

**Evidence:** `getOrCreateOpenAgentsSlackSession()` returns an existing `slack_thread_sessions` row before looking up the current Slack author (`agent/lib/open-agents-slack-session.ts:341-349`). The link lookup only runs for new threads (`agent/lib/open-agents-slack-session.ts:351-357`). The later Eve turn is sent with `input.session.userId`, i.e. the user stored on the thread, not the current Slack author (`agent/lib/open-agents-slack-session.ts:435-439`). Any Slack user who can post in an existing thread can drive the creator's Open Agents session and sandbox.

**Fix/alternative:** Re-resolve the Slack author on every message. For channel-group sessions, require that the linked Open Agents user is currently a member of the synced group before sending. If unlinked users are allowed to participate, make that an explicit service-identity mode with limited tools, clear attribution, and policy controls; do not silently run as the thread creator.

### 5. BLOCKER — The handoff design does not answer the first routed message with the target agent

**Claim/design element:** §4.5 says Slack channel ingress defaults to the router, the first turn triages and hands off, and the next turn runs with the target agent's tools/system prompt.

**Evidence:** Eve's turn re-resolution support is real (`node_modules/eve/docs/guides/dynamic-capabilities.md:55-71`), but the design explicitly relies on the target taking effect on the next turn. That means the user's first Slack/web message is consumed by the router turn; the target agent does not process it unless the user sends another message or the system creates another continuation. A visible marker event is not a response to the task.

**Fix/alternative:** Route before starting the Eve turn, or use Eve subagents for same-turn delegation. If profile-swap handoff is still needed, the handoff tool must enqueue a synthetic follow-up turn with the original task/brief after the current turn reaches `session.waiting`, under the same single-writer lock. Otherwise Slack ingress will regularly hand off and stop before doing the work.

### 6. MAJOR — The authz levels contradict the required library-write policy

**Claim/design element:** §4.1 says v1 `write` includes "send messages, edit docs, edit library items" for any member of the scope, while the immediate fix says org-scoped library writes require org admin and group-scoped writes require manager/admin.

**Evidence:** The current bug is exactly that any authenticated user can write/delete org library items: the route accepts `scope='org'` and calls `saveAgentDefinition`/`deleteAgentDefinition` with no role check (`apps/open-agents/app/api/settings/agent-library/route.ts:72-78`, `157-170`). The repository maps org saves to the global org scope id (`apps/open-agents/lib/agents/repository.ts:287-297`). A coarse `canAccess(..., 'write')` where every org member can edit library items preserves the security hole under a new name.

**Fix/alternative:** Replace the generic `read|write|admin` model with action-specific permissions: `session.send`, `doc.edit`, `library.manage`, `automation.manage`, `scope.change`, etc. At minimum, library manage must be manager/admin only; do not route it through the same write bit as chat messages.

### 7. MAJOR — User-scope break-glass is undefined and unsafe for multi-org

**Claim/design element:** §4.1 says `user:U` is only U plus org admins for break-glass, and the schema is multi-org capable.

**Evidence:** A user-scoped resource has only `scope_kind='user', scope_id=user_id`; there is no org id on the scope. Current sessions likewise only have `user_id` and no tenant/home org (`apps/open-agents/lib/db/schema.ts:119-188`). In a multi-org future, the design cannot answer which org's admins can break glass on a user's private resource, especially when users belong to multiple orgs or change org membership over time.

**Fix/alternative:** Do not bake break-glass into normal `canAccess`. Either remove org-admin access to user-scoped resources, or add an immutable tenant/home org to user-scoped resources and implement break-glass through a separate audited grant table with reason, actor, expiry, and reviewed access logs.

### 8. MAJOR — “Share chat” actually shares the whole session/workspace and can leak sibling chats

**Claim/design element:** §4.1 says chats inherit their session's scope; §4.2 presents the UX as multiplayer/shareable chats and a session-header visibility control.

**Evidence:** Current data model allows multiple chats under one session (`apps/open-agents/lib/db/schema.ts:190-204`), while public shares are chat-level (`shares.chat_id`). Upgrading the session scope exposes every chat in that session, not just the chat whose URL/header the user is looking at. That may be technically consistent with sandbox sharing, but it violates the target feature wording of shareable chats and creates an easy product foot-gun.

**Fix/alternative:** Make the UX and API say “share workspace/session” everywhere, show a preflight list of all chats/sandbox effects being shared, and require admin-level confirmation. For true chat-sharing, fork the chat into a new session/workspace or restrict shared sessions to one chat.

### 9. MAJOR — SSE fan-out on Vercel/Postgres is underspecified and likely to exhaust runtime resources

**Claim/design element:** §4.2 proposes an SSE endpoint that replays DB events and tails with LISTEN/NOTIFY or 1s polling fallback on Vercel.

**Evidence:** The platform briefing says Vercel connections are function-duration-bound and instance-pinned. The app's Postgres client is configured with `max: 1` per pool (`apps/open-agents/lib/db/sql.ts:38-42`). A LISTEN-per-viewer design consumes long-lived DB connections; a 1s poll-per-viewer design turns every open chat tab into constant database load. Both choices also rely on clients reconnecting at function max duration.

**Fix/alternative:** Use DB replay only for catch-up and a real fan-out layer for hot tails: Redis pub/sub/streams, a small always-on realtime service, or an Eve-stream-backed broadcaster. If SSE remains, make connections short-lived and cursor-based by design, and do not use one Postgres LISTEN connection per viewer.

### 10. MAJOR — Long turns are still tied to a single serverless invocation

**Claim/design element:** §4.2 says web sends can run in a Next route with raised `maxDuration` or be wrapped in Vercel Workflow, with Workflow as the safer default.

**Evidence:** `runEveChatMessageTurn()` consumes the whole Eve stream before returning (`apps/open-agents/lib/chat/eve-runtime.ts:83-95`). The automation workflow step calls that function directly (`apps/open-agents/lib/automation/actions.ts:358-389`). Wrapping the same blocking stream drain in Workflow does not by itself make the drain resumable across function max duration, deploy interruption, or network loss.

**Fix/alternative:** Split send acceptance from stream draining. Persist the pending cursor immediately, then run a resumable drain worker/workflow that can resume from `sessionId` + `startIndex` and idempotently append events. Eve hooks are also a plausible persistence mechanism if the hook↔chat mapping is solved. Do not require one uninterrupted function invocation for an entire agent turn.

### 11. MAJOR — Slack workspace/group design conflicts with the current one-Slack-link-per-user schema

**Claim/design element:** §4.3 adds `slack_workspace_links` and syncs channel membership across workspaces.

**Evidence:** `slack_user_links` currently has a unique index on `user_id` (`apps/open-agents/lib/db/schema.ts:50-66`), so one Open Agents user can link only one Slack identity total. The proposed workspace-link model needs users to be linkable in multiple Slack workspaces/teams, and Enterprise Grid should be keyed by enterprise/team/user, not just a single user row.

**Fix/alternative:** Migrate `slack_user_links` to allow many Slack identities per Open Agents user. Keep uniqueness on the external identity, add `slack_enterprise_id` where available, and remove the unique `user_id` index or replace it with a non-unique lookup index.

### 12. MAJOR — Automation scope migration omits `automation_events`

**Claim/design element:** §4.1 only calls out adding `group`/`org` to `automation_definitions.scope_kind`; §4.6 says canonical chat turns emit `chat.turn_completed` / `chat.turn_failed` / lifecycle events onto `automation_events`.

**Evidence:** `automation_definitions.scope_kind` and the TypeScript definition scope currently have their own enum (`apps/open-agents/lib/db/schema.ts:293-300`, `apps/open-agents/lib/automation/types.ts:4-12`), but `automation_events.scope_kind` is a separate enum that lacks `group` and `org` (`apps/open-agents/lib/db/schema.ts:339-348`, `apps/open-agents/lib/automation/types.ts:14-21`). A group-scoped session emitting a chat automation event cannot be represented unless the event schema, parser, matchers, dedupe indexes, and route conditions all migrate too.

**Fix/alternative:** Treat automation scope as a shared canonical type and migrate every table/parser/store path together: definitions, events, invocations/runs accessors, scheduler, webhook emitters, `emitEvent`, condition helpers, UI filters, and dedupe keys.

### 13. MAJOR — The handoff tool cannot be “just” a library tool under current tool allowlists

**Claim/design element:** §4.5 adds a dynamic tool `handoff_to_agent({slug, brief})`.

**Evidence:** Agent/library tool selection is hard-coded to the current Open Agents tool set (`apps/open-agents/lib/agents/definitions.ts:4-13`; `agent/lib/open-agents-profile.ts:101-117`). Dynamic profile tools are emitted only from that allowlist (`agent/tools/open_agents_profile.ts:17-24`). Automation policy filtering also uses the same built-in tool IDs. `handoff_to_agent` will not appear unless multiple allowlists, schemas, UI editors, and policy filters are updated.

**Fix/alternative:** Model `handoff_to_agent` as a first-class built-in Open Agents tool with explicit policy, schema, audit event, and UI representation. Add it to the canonical tool definitions and decide whether ordinary agents can use it or only the reserved router profile can.

### 14. MAJOR — The proposed handoff marker does not belong in `eve_chat_events`

**Claim/design element:** §4.5 says `handoff_to_agent` appends a visible "handed off to X" marker event.

**Evidence:** `eve_chat_events.event` is typed and consumed as `HandleMessageStreamEvent` (`apps/open-agents/lib/db/schema.ts:215-227`). UI projection runs the Eve `defaultMessageReducer` over those events (`apps/open-agents/lib/chat/eve-message-projection.ts`). An application-defined marker is not an Eve protocol event and may be ignored or break reducers/clients depending on runtime assumptions.

**Fix/alternative:** Store app-level markers in a separate `chat_app_events`/`chat_annotations` table and merge them in the read projection, or have the tool return/output a normal Eve-visible assistant/tool result that the reducer already understands.

### 15. MAJOR — The docs agent-write path bypasses the collaboration broadcaster

**Claim/design element:** §4.4 says agents can `write_doc_section` / `append_doc` via a Hocuspocus REST hook or direct update+snapshot write, and live viewers see agent edits streaming.

**Evidence:** Yjs clients see updates through the collaboration provider, not by polling Postgres snapshots. Directly appending binary updates/snapshots to Postgres is durable storage, but it does not by itself broadcast the update to connected Hocuspocus/Yjs clients or update awareness/state vectors in memory.

**Fix/alternative:** Route every doc mutation, including agents, through the same collaboration service that owns the Y.Doc and websocket room, or publish direct DB writes through a Redis/Postgres notification path that Hocuspocus consumes and broadcasts. Keep direct snapshot writes for compaction only.

### 16. MAJOR — Yjs-on-Vercel is still a research item, not a foundation

**Claim/design element:** §4.4 proposes Hocuspocus first as a Vercel Fluid Compute websocket route, with an always-on host as fallback if churn hurts.

**Evidence:** The platform briefing says Vercel WebSockets are pinned to one function instance, close at function max duration, need external pub/sub/presence for durable rooms, and Next.js requires `@vercel/functions` `experimental_upgradeWebSocket`. Hocuspocus is an OSS websocket server with Redis scaling, but the design has not proven that its server lifecycle maps cleanly onto a Next route/function deployment.

**Fix/alternative:** Make the collaboration host decision a pre-Phase-3 spike with a pass/fail gate. The safer default is a small always-on Hocuspocus service, Hocuspocus Cloud/on-prem, PartyKit-style host, or Vercel Services + Redis/Postgres topology. If Vercel Functions remain the target, presence/pubsub/reconnect behavior must be in the design, not deferred to “if it hurts.”

### 17. MAJOR — Better Auth organization plugin is not “free” with the current auth schema/defaults

**Claim/design element:** §4.1 says the Better Auth organization plugin buys invitations, role management, and session-active-org handling for free.

**Evidence:** The plugin defaults allow any user to create organizations (`node_modules/better-auth/dist/plugins/organization/types.d.mts:8-22`) and default membership limit is 100 (`node_modules/better-auth/dist/plugins/organization/types.d.mts:47-53`). It also expects session fields like `activeOrganizationId` (`node_modules/better-auth/dist/plugins/organization/schema.d.mts:182-186`), while the current `auth_sessions` schema has no such column (`apps/open-agents/lib/db/auth-schema.ts`). Those defaults do not match a single `goaugment` org with all users backfilled.

**Fix/alternative:** Configure the plugin explicitly: disable arbitrary org creation/deletion, set/override membership limits, add/migrate the session active-org fields, map custom table/model names, and decide whether plugin endpoints are exposed. Treat this as schema/application integration work, not a drop-in.

### 18. MAJOR — Phase 1 has a package boundary problem hidden in a spike

**Claim/design element:** §4.2 says Slack should drop its raw SQL loop and call `runEveChatMessageTurn()`.

**Evidence:** `runEveChatMessageTurn()` lives inside the Next app and imports app aliases, UI message types, Drizzle app client, and projection code (`apps/open-agents/lib/chat/eve-runtime.ts:1-15`). The Slack implementation lives under the Eve agent tree and currently uses raw `postgres` without depending on the Next app module graph. Pulling the app runtime into `agent/` risks Eve build/runtime alias failures and couples Slack agent code to web UI projection.

**Fix/alternative:** Extract a pure shared chat runtime package/module that has no `@/app` UI types and no Next-only imports. Put Eve send/cursor/event persistence there. Keep web-specific `WebAgentUIMessage` conversion and projection in the app layer.

### 19. MAJOR — Migration/backfill can strand existing org library rows, Slack threads, and active turns

**Claim/design element:** §4.1 leaves the org id decision open: rewrite `OPEN_AGENTS_ORG_SCOPE_ID` rows to a new org id or keep `'default'`; §4.7 says old paths are removed, not bridged.

**Evidence:** Agent/library reads currently look at `OPEN_AGENTS_ORG_SCOPE_ID || 'default'` (`apps/open-agents/lib/agents/repository.ts:287-297`; `agent/lib/open-agents-profile.ts:130-134`). If Better Auth creates a different org id and rows are not atomically rewritten/configured, org agents/skills disappear. Existing `slack_thread_sessions` point at user-scoped sessions and the design does not specify whether old channel threads are upgraded to channel groups. Active browser tabs currently persist through `/api/sessions/:id/chats/:id/eve`; removing that endpoint while an Eve stream is in flight can leave accepted Eve turns without corresponding DB events.

**Fix/alternative:** Decide the org id before implementation and make it a migration invariant. Backfill or explicitly grandfather existing Slack thread sessions. Deploy chat persistence in two phases: add server-authoritative read/send while keeping the old persistence endpoint until active client-driven turns have drained, then remove browser persistence.

### 20. MINOR — The persistence design contradicts itself about hooks

**Claim/design element:** §4.2 rejects Eve hooks for persistence and says the canonical runtime owns persistence; later §4.2 says Slack convergence drops the raw loop because “the hook owns it,” and the phase table says Phase 1 ships “persist hook + registry.”

**Evidence:** These are mutually different architectures. A hook-owned design needs hook-to-chat mapping and hook failure semantics; a runtime-owned design needs every sender to use the canonical runtime.

**Fix/alternative:** Pick one architecture in the design. If runtime-owned, delete hook references from Slack convergence and Phase 1. If hook-owned, promote it to the main design and specify mapping, auth context, idempotency, and failure handling.

## Additional Section Notes

- §4.1 should define cache invalidation for `resolveMembership`. Request-local caching is fine; cross-request TTL caching can retain access after org/group removal unless every membership mutation bumps a version or invalidates keys.
- §4.3 should specify channel member removal semantics for already-open web streams and docs tokens. A removed Slack/group member should lose access on the next request/reconnect, and long-lived SSE/doc websocket tokens need short TTLs.
- §4.6 should define dedupe keys for internally emitted `chat.turn_completed` / `chat.turn_failed` events. Re-draining an Eve stream or retrying a workflow must not emit duplicate automation events.
- The docs comments plan should specify the exact Yjs RelativePosition serialization (`Y.relativePositionToJSON`/restore target type) and schema migration strategy for TipTap/Yjs documents.

## Verdict

### Blockers

- `409 busy` is not atomic and does not protect Eve's single active continuation token.
- `runEveChatMessageTurn()` does not persist the continuation cursor immediately after `send()`; replacing Slack with it regresses durability.
- Shared/group sends do not fit the current Eve auth/profile resolver, which still requires actor == `sessions.user_id` and server sends omit actor identity.
- Existing Slack threads let unlinked users write as the original thread creator.
- Router handoff only affects the next turn, so the first routed message is not handled by the target agent.

### Majors

- Coarse `read|write|admin` permissions conflict with required agent-library manager/admin writes.
- User-scope org-admin break-glass has no org anchor and is unsafe for multi-org.
- Chat sharing semantics actually expose whole sessions/workspaces and can leak sibling chats.
- SSE/LISTEN or 1s polling fan-out on Vercel/Postgres is not a sound realtime foundation.
- Long Eve turns still depend on a single uninterrupted serverless route/workflow step.
- Slack user links currently prevent multi-workspace linking.
- Automation scope migration misses `automation_events` and related parsers/matchers.
- `handoff_to_agent` is blocked by hard-coded tool allowlists and policy schemas.
- Handoff marker events need an app-event channel, not arbitrary Eve protocol rows.
- Direct docs DB writes will not broadcast Yjs updates to live clients.
- Hocuspocus-on-Vercel needs a gated deployment spike before being a foundation.
- Better Auth org plugin needs explicit schema/default configuration.
- Slack calling the Next-app `eve-runtime.ts` crosses package/runtime boundaries.
- Migration plan can strand org library rows, existing Slack threads, and active browser-driven turns.

### Minors

- The design contradicts itself on whether persistence is runtime-owned or hook-owned.
- Membership cache invalidation, token/SSE revocation timing, internal automation event dedupe, and Yjs comment anchor serialization need to be specified before implementation.
