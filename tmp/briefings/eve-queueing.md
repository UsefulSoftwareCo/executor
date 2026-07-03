# Eve 0.18.2 Chat-Send Queueing Briefing

Authoritative package inspected: installed `node_modules/eve` version `0.18.2`.

## Executive Takeaway

Eve 0.18.2 already provides durable sessions, durable turn execution, replayable per-session event streams, continuation-token ownership, client-side stream reconnect/replay by `startIndex`, and Vercel Workflow / Workflow SDK integration. It does **not** provide the deterministic per-chat FIFO send queue we are designing. The docs explicitly recommend keeping our own per-session queue in the channel/app layer when bursts can arrive while the agent is working.

The likely shape for our design is:

- Keep our per-chat single-writer / CAS gate and app-level queue for deterministic chat sends.
- Use Eve’s native `ClientSession.stream({ startIndex })` or `Session.getEventStream({ startIndex? })` for repair-on-read / replay rather than hand-rolling raw NDJSON attach logic.
- Treat Eve’s stream as authoritative for Eve-run events, but keep `eve_chat_events` as our product/UI projection unless we have an explicit retention/deletion SLA from the selected Workflow world. The vendored docs do not state a durable retention window.
- Do not assume Slack channel serialization exists; the Slack channel anchors sessions to threads and replies in-thread, but the docs/types do not expose a per-thread FIFO send serializer.

## 1. Concurrent/stale continuation sends and queueing

### What Eve says about continuation ownership

Eve distinguishes continuation tokens from stream handles: `continuationToken` is the resume handle, while `sessionId`/`runId` are for streaming/inspection (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:8-15`). The docs state: “A session has one active continuation at a time: each follow-up uses the current `continuationToken`, and a stale one is rejected” (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:15`).

Follow-ups are supposed to be sent only after `session.waiting`: “Once the session is waiting (you'll see `session.waiting`), POST your follow-up…” (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:75-83`). The docs then say deterministic ordering requires one follow-up at a time and waiting for the next `session.waiting` (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:89`). The client guide says the same at a higher level: `ClientSession` sends one turn at a time; later sends continue the same conversation only while the previous turn left the session waiting (`node_modules/eve/docs/guides/client/messages.mdx:6`).

### Exact concurrent-send / queueing contract

The core queueing section is explicit:

- “eve does not maintain a durable FIFO queue of user messages for a session” (`node_modules/eve/docs/concepts/execution-model-and-durability.md:53-56`).
- The continuation token is “a resume handle for the session's current workflow hook, not a general message-queue address” (`node_modules/eve/docs/concepts/execution-model-and-durability.md:55`).
- Only one active session can own a continuation token; when a session starts with a token, Eve commits the park hook before processing its first turn and fails a competing session if another run already owns that token (`node_modules/eve/docs/concepts/execution-model-and-durability.md:57`).
- Competing input is **not** forwarded to the owner (`node_modules/eve/docs/concepts/execution-model-and-durability.md:57`).
- When a turn is active, “the hook may accept additional deliveries,” but the runtime drains them only at specific workflow boundaries; multiple ready deliveries may be folded into the next turn, and that drain is “best-effort” and timing-dependent (`node_modules/eve/docs/concepts/execution-model-and-durability.md:59`).
- The docs conclude: “don't rely on concurrent sends to the same session behaving like a typical ordered chat queue”; if bursts can arrive, “keep your own per-session queue in the channel or app layer, then deliver the next message after the session parks again” (`node_modules/eve/docs/concepts/execution-model-and-durability.md:61`).

So Eve has native hook-level delivery mechanics, but not the deterministic chat queue we need.

### Error type/code/status for stale or second continuation

The public client error surface is generic: non-2xx HTTP responses throw `ClientError`, which carries only `status` and raw `body` (`node_modules/eve/dist/src/client/client-error.d.ts:1-13`). The messages guide confirms transport/route errors throw `ClientError`, while `session.failed` in the stream returns a failed result rather than throwing (`node_modules/eve/docs/guides/client/messages.mdx:27-38`).

The installed JS shows internal continuation ownership conflicts are represented as `HookConflictError` with message `Hook token "..." is already in use` and fields `{ name: "HookConflictError", token, conflictingRunId? }` (`node_modules/eve/dist/src/execution/hook-ownership.js:1`). The bundled Workflow SDK also defines `HookConflictError` with slug/code category `HOOK_CONFLICT` / `hook-conflict` and message `Hook token "..." is already in use by another workflow...` (`node_modules/eve/dist/src/compiled/_chunks/workflow/dist-Dxrjttr2.js:3`).

For stale/no-active-session delivery, Eve has an internal `RuntimeNoActiveSessionError` with `code = "NO_ACTIVE_SESSION"` and message `No active session for continuationToken "..."` (`node_modules/eve/dist/src/execution/runtime-errors.js:1`). Channel `send()` catches `RuntimeNoActiveSessionError` and falls back to starting a new session for normal messages; if the payload is `inputResponses`, it throws `Cannot deliver inputResponses — the target session was not found via continuation token.` (`node_modules/eve/dist/src/channel/send.js:1`). The public `ClientSession` POST retry logic only special-cases HTTP `500` bodies matching `target session was not found` for must-deliver input responses, retrying up to 10 times; other non-OK responses become `ClientError(status, body)` (`node_modules/eve/dist/src/client/session.js:1`).

What is **not** exposed in the docs/types: a stable public HTTP status or JSON error code for “stale continuation token” on `session.send()`. The docs say stale tokens are rejected, and the internals show `HookConflictError` / `NO_ACTIVE_SESSION`, but the public client type only guarantees `ClientError.status` plus raw body.

### Built-in follow-up / waiting primitives

Eve has follow-up sends and HITL/input-response sends, but not a send-when-waiting queue primitive.

- Raw HTTP follow-up: `POST /eve/v1/session/<sessionId>` with `continuationToken` and `message` (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:75-85`).
- `input.requested` pauses can be answered by sending `inputResponses` through the same session (`node_modules/eve/docs/guides/client/messages.mdx:101-128`).
- `SendTurnPayload` supports `message`, `inputResponses`, `clientContext`, `outputSchema`, `signal`, and per-turn `headers`; there is no queue/followUpLater/sendWhenWaiting option in the type (`node_modules/eve/dist/src/client/types.d.ts:89-133`).
- The `ClientSession` public methods are only `send(input)` and `stream(options?)` (`node_modules/eve/dist/src/client/session.d.ts:22-49`).

## 2. Resume / attach / replay API by `sessionId` + `startIndex`

Eve provides this natively at HTTP, client, custom-channel, frontend, and eval surfaces.

### HTTP

The stream endpoint is `GET /eve/v1/session/<sessionId>/stream`; pass `startIndex` to reconnect by event count or rewind (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:91-97`). The route constants are `EVE_MESSAGE_STREAM_ROUTE_PATTERN = /eve/v1/session/:sessionId/stream` and `createEveMessageStreamRoutePath(sessionId)` (`node_modules/eve/dist/src/protocol/routes.js:1`).

### TypeScript client

`Client.session(state?: SessionState | string): ClientSession` creates/resumes a session handle; `SessionState` is `{ continuationToken?: string; sessionId?: string; streamIndex: number }` (`node_modules/eve/dist/src/client/client.d.ts:42-49`, `node_modules/eve/dist/src/client/types.d.ts:195-202`).

`ClientSession.stream(options?: StreamOptions): AsyncIterable<HandleMessageStreamEvent>` attaches to the current session stream; it resumes from stored `streamIndex` unless `options.startIndex` overrides it and reconnects transient disconnects up to `maxReconnectAttempts` (`node_modules/eve/dist/src/client/session.d.ts:40-49`). `StreamOptions` is `{ startIndex?: number; signal?: AbortSignal }` (`node_modules/eve/dist/src/client/types.d.ts:135-147`). The guide shows `session.stream({ startIndex: 0 })` (`node_modules/eve/docs/guides/client/streaming.mdx:98-122`).

The client implementation uses `startIndex` to build the stream URL query and retries transient stream-open statuses `404,409,425,500,502,503,504` (`node_modules/eve/dist/src/client/open-stream.js:1`). It also advances the local stream cursor after streaming (`node_modules/eve/dist/src/client/session.js:1`).

### Custom channels and frontend guidance

Custom channels can call `getSession(sessionId).getEventStream({ startIndex? })` (`node_modules/eve/docs/channels/custom.mdx:47-51`). Frontend docs explicitly recommend reconnecting an interrupted in-flight turn with `session.stream({ startIndex: savedEvents.length })` after persisting `sessionId` and pending user message (`node_modules/eve/docs/guides/frontend/overview.mdx:251-255`). Evals have `t.target.attachSession(sessionId, { startIndex? })` with the same semantics (`node_modules/eve/docs/evals/targets.mdx:25-28`).

Conclusion: repair-on-read should reuse Eve’s client/channel attach APIs unless we need lower-level HTTP control.

## 3. Event-log durability, retention, `preserveCompletedSessions`, and system-of-record implications

### Durability guarantees documented

Eve sessions are durable and survive process restarts/redeploys; Eve runs turns as durable workflows and checkpoints/serializes durable state at each step boundary (`node_modules/eve/docs/concepts/execution-model-and-durability.md:6-18`). After a crash/timeout/redeploy mid-turn, the run resumes from the last completed step; completed steps never re-run, interrupted steps re-run (`node_modules/eve/docs/concepts/execution-model-and-durability.md:41-45`). Parked work suspends durably with no compute until input arrives (`node_modules/eve/docs/concepts/execution-model-and-durability.md:49-51`).

For stream events specifically: “The stream is durable. Every event is recorded before a step completes, so the whole stream is replayable” (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:91-97`). Hooks run after events are durably recorded, and if a hook throws, the stream remains consistent (`node_modules/eve/docs/guides/hooks.md:74-86`).

Eve stores “durable session and workflow state needed to resume conversations, stream events, replay completed steps, and show run observability” (`node_modules/eve/docs/concepts/security-model.md:45`).

### Retention / replay window

The vendored docs I inspected do **not** state a concrete retention period, replay window, or deletion SLA for the event log. The security model explicitly puts responsibility on the app owner to decide whether selected channels/providers/telemetry/exporters and “retention settings, and deletion controls” are appropriate (`node_modules/eve/docs/concepts/security-model.md:45`). Deployment docs say the backing Workflow world differs by host: local/self-hosted default persists workflow runs on disk under `.workflow-data`, while Vercel uses Vercel Workflow (`node_modules/eve/docs/concepts/execution-model-and-durability.md:18`; `node_modules/eve/docs/guides/deployment.md:20-23`, `node_modules/eve/docs/guides/deployment.md:141-144`). The root agent can select a Workflow world package via `experimental.workflow.world`; that world backs workflow state, queues, hooks, and streams (`node_modules/eve/docs/concepts/execution-model-and-durability.md:24-39`; `node_modules/eve/docs/agent-config.md:104-150`).

Implication: Eve’s stream is replayable within the guarantees of the configured Workflow world, but Eve 0.18.2’s vendored docs do not establish a product retention contract that would let us delete our Postgres projection solely on the basis of a stated replay window.

### `preserveCompletedSessions`

`ClientOptions.preserveCompletedSessions?: boolean` is client-side behavior: keep a session’s continuation token after a normal `session.completed` boundary. By default, completed turns reset the client-side session so the next `send()` starts a fresh server-side conversation; setting it preserves durable session state, including framework-managed sandbox state, across follow-up prompts until the caller creates a new session (`node_modules/eve/dist/src/client/types.d.ts:73-86`). The continuations guide says when a turn ends with `session.completed` or `session.failed`, the client resets local state and the next send starts fresh (`node_modules/eve/docs/guides/client/continuations.mdx:65-80`).

This flag is **not** an event-log retention flag. It only changes whether the client keeps using a completed session’s continuation token.

### Can Eve’s stream be the system of record?

For Eve-run events, the stream is the canonical replay source: docs say every event is recorded and replayable (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:91-97`). But Eve’s own client/frontend docs still advise database-backed chat apps to persist stream events as they arrive and save final snapshots (`node_modules/eve/docs/guides/frontend/overview.mdx:251-255`). The continuations guide also says `SessionState` is only a cursor, not a transcript; apps that display historical messages should persist stream events separately under their own chat/thread ID (`node_modules/eve/docs/guides/client/continuations.mdx:26-39`).

Given the missing retention SLA and our need to bind events to app chat rows, pending sends, UI projections, and possibly product deletion/export policy, `eve_chat_events` should remain at least a derivable/cache/projection table for now. Promoting Eve’s stream to sole system of record would require confirming the configured Workflow world’s retention/deletion guarantees.

## 4. Slack channel per-thread serialization

Slack’s built-in channel provides thread anchoring and delivery conveniences, but I found no documented per-thread FIFO serialization primitive.

What Slack channel does provide:

- It answers mentions/DMs, replies in threads, shows typing indicators, and turns HITL prompts into buttons (`node_modules/eve/docs/channels/slack.mdx:7`).
- It attributes triggering Slack user id to the model message so several people can use one thread with speaker attribution (`node_modules/eve/docs/channels/slack.mdx:57`).
- Optional `threadContext` fetches previous Slack thread replies and can limit context since the last agent reply (`node_modules/eve/docs/channels/slack.mdx:59-71`; `node_modules/eve/dist/src/public/channels/slack/thread.d.ts:1-30`).
- The first agent post can anchor a proactive session to the Slack message timestamp, and later posts/mentions resume that same session (`node_modules/eve/docs/channels/slack.mdx:73-78`).
- `SlackChannelState` stores `channelId`, `threadTs`, `teamId`, `triggeringUserId`, and status-message bookkeeping, but no queue/lock/serializer field (`node_modules/eve/dist/src/public/channels/slack/slackChannel.d.ts:84-126`).
- `SlackReceiveTarget` accepts `{ channelId, threadTs?, initialMessage? }`, again with no queueing/serialization option (`node_modules/eve/dist/src/public/channels/slack/slackChannel.d.ts:164-183`).

What is absent: neither `slack.mdx` nor the public Slack `.d.ts` surfaces mention per-thread send serialization, ordered burst delivery, queueing, CAS, or “send after waiting.” The global Eve queueing docs apply: if a channel can receive bursts while the agent is working, keep an app/channel-layer per-session queue (`node_modules/eve/docs/concepts/execution-model-and-durability.md:61`).

## 5. Eve + Vercel Workflow / Workflow SDK integration points

Eve’s turn runtime is already built on Workflow SDK, and on Vercel it uses Vercel Workflow:

- “Every turn runs as a durable workflow, built on the open-source Workflow SDK (Vercel Workflow when you deploy on Vercel)” (`node_modules/eve/docs/concepts/execution-model-and-durability.md:16`).
- Local/self-hosted `eve start` uses the SDK’s local world by default, persisted under `.workflow-data`; Vercel runs the same workflow code against Vercel Workflow (`node_modules/eve/docs/concepts/execution-model-and-durability.md:18`).
- Nitro hosts HTTP routes and workflow entrypoints, but workflow state store and sandbox runtime are separate adapters (`node_modules/eve/docs/concepts/execution-model-and-durability.md:22`).
- Advanced self-hosts can set `experimental.workflow.world` in `agent.ts`; the world package backs workflow state, queues, hooks, and streams and must match Eve’s bundled `@workflow/*` line (`node_modules/eve/docs/concepts/execution-model-and-durability.md:24-39`; `node_modules/eve/docs/agent-config.md:104-150`).
- Deployment docs warn proxies must forward both `/eve/` and `/.well-known/workflow/`; otherwise sessions can start but runs stall because workflow callbacks never reach Eve (`node_modules/eve/docs/guides/deployment.md:141-152`).
- Docs say user code generally should not write Workflow code directly; Workflow primitives like `start()` and `resumeHook()` are runtime implementation details, while tools/channels/hooks use Eve surfaces (`node_modules/eve/docs/concepts/execution-model-and-durability.md:41-48`).

The installed runtime internals confirm use of Workflow hooks for continuation/inbox mechanics: `createSessionDeliveryHook` uses `createHook({ token })`, `claimHookOwnership`, hook iterators, and rekey/dispose flow (`node_modules/eve/dist/src/execution/session-delivery-hook.js:1`); turn workflow code creates a turn inbox hook `${completionToken}:inbox`, claims ownership, and uses `turn-delivery-request` / `turn-delivery-accepted` control messages for proxy input during runtime action waits (`node_modules/eve/dist/src/execution/turn-workflow.js:1`). These are not public app-level queue APIs.

## Direct answers to planned machinery

### (a) Per-chat single-writer lock / CAS

Partially native but insufficient. Eve enforces single continuation ownership and rejects stale tokens (`node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:15`; `node_modules/eve/docs/concepts/execution-model-and-durability.md:57`), with internal `HookConflictError` / `NO_ACTIVE_SESSION` shapes (`node_modules/eve/dist/src/execution/hook-ownership.js:1`; `node_modules/eve/dist/src/execution/runtime-errors.js:1`). But this is not a public deterministic app-level CAS API and does not forward competing input to the active owner (`node_modules/eve/docs/concepts/execution-model-and-durability.md:57`). Keep our single-writer guard for chat state and token advancement.

### (b) Message queue for sends while a turn is running

Not provided as a durable FIFO. Eve explicitly says it does not maintain one and recommends our own per-session queue in channel/app layer (`node_modules/eve/docs/concepts/execution-model-and-durability.md:53-61`). Eve may accept/fold extra deliveries best-effort at workflow boundaries, but that behavior is timing-dependent (`node_modules/eve/docs/concepts/execution-model-and-durability.md:59`). Keep our queue.

### (c) Repair-on-read by redraining missed events from `stream?startIndex=N`

Provided natively. Use `ClientSession.stream({ startIndex })`, custom-channel `getSession(sessionId).getEventStream({ startIndex? })`, or raw HTTP `GET /eve/v1/session/:id/stream?startIndex=N` (`node_modules/eve/dist/src/client/session.d.ts:40-49`; `node_modules/eve/dist/src/client/types.d.ts:135-147`; `node_modules/eve/docs/concepts/sessions-runs-and-streaming.md:91-97`; `node_modules/eve/docs/channels/custom.mdx:47-51`). Frontend docs explicitly recommend this for interrupted in-flight turns (`node_modules/eve/docs/guides/frontend/overview.mdx:251-255`).

### (d) Sweeper for abandoned turns

Eve provides durable workflow resume after crashes/redeploys and stream reconnect, so it reduces the need for a sweeper that “continues Eve’s work” (`node_modules/eve/docs/concepts/execution-model-and-durability.md:41-45`). It does not provide our product-level abandoned-turn sweeper for app DB rows/locks/queued messages. Since `session.waiting` is the boundary for delivering the next queued send and no FIFO queue is native, our sweeper still needs to repair app state by reattaching/replaying and then draining our queue.

## Remaining Unknowns / Things to Verify Against Runtime

- Public HTTP status/body for stale continuation and active-turn second sends is not specified in docs or public types. Public client only promises `ClientError(status, body)` for non-2xx route errors (`node_modules/eve/dist/src/client/client-error.d.ts:1-13`). Internals expose `HookConflictError` and `RuntimeNoActiveSessionError`, but not a stable public API contract.
- No vendored retention window was found for stream replay. Retention depends on the selected Workflow world / platform. Verify Vercel Workflow and any self-hosted world SLA before making Eve stream the only durable transcript.
- Slack channel serialization was not found in docs/types. Runtime Slack implementation could contain incidental ordering behavior, but there is no public contract to rely on.
