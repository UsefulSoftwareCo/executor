# Vercel durable chat pipeline briefing — July 2026

## Executive verdict

Vercel now provides more of this pipeline than early-2025 assumptions would suggest, especially for durable AI-agent execution and resumable workflow streams. The strongest platform-native candidate is **WorkflowAgent + Workflow streams**: `WorkflowAgent` persists agent state across process restarts/function timeouts, writes durable stream chunks to Workflow-managed storage, and `WorkflowChatTransport` resumes client reads by workflow run ID and stream index. That directly overlaps with our planned split between send acceptance and stream draining.

Vercel does **not** provide strict per-chat FIFO serialization through Vercel Queues. Queues are durable, at-least-once, replicated topics with consumer groups and retries, but the docs explicitly say delivery is approximate write order and **no FIFO guarantee, even with one consumer and max concurrency 1**. Our per-chat single-writer claim still needs either Postgres locking/sequence enforcement, a Workflow hook loop per chat/session, or another single-threaded actor primitive.

Vercel also provides Workflow hooks/webhooks that can send typed payloads into a suspended workflow, including reusable async-iterable hooks for multiple events. That is close to “send messages into a running workflow,” but it is a suspension/resume primitive, not a queue with strict per-key ordering or arbitrary concurrent delivery semantics. A chat agent can be modeled as a workflow that repeatedly waits on a deterministic per-chat hook token; ordering and acceptance still need deliberate design.

## Existing repo usage and proven patterns

- The app already depends on `workflow@5.0.0-beta.26`, `@ai-sdk/workflow`, Next `16.2.10`, and `ioredis` in [apps/open-agents/package.json](/home/dana/projects/augment/agents/executor/apps/open-agents/package.json:20) and [apps/open-agents/package.json](/home/dana/projects/augment/agents/executor/apps/open-agents/package.json:86). Root catalog pins `@ai-sdk/workflow` at `^1.0.11` in [package.json](/home/dana/projects/augment/agents/executor/package.json:168).
- Automation runs already use Workflow steps, metadata, starts, hook waits, and step retry knobs. `automationRunWorkflow` is marked with `"use workflow"`, prepares a run, creates an approval hook, starts a timeout child workflow, awaits a hook decision, and executes a retryable action step; see [automation-run.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-run.ts:1), [automation-run.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-run.ts:61), [automation-run.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-run.ts:109), [automation-run.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-run.ts:137), and [automation-run.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-run.ts:178).
- Hook tokens are first-class in the repo. `automationApprovalHook` is a typed `defineHook` in [hooks.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/lib/automation/hooks.ts:1), and approval rows persist `workflowHookToken` in [schema.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/lib/db/schema.ts:545).
- The repo already uses Workflow sleep for sweeper-like timeout behavior: `automationApprovalTimeoutWorkflow` sleeps until `timeoutMs`, expires the approval if still requested, then resumes the hook with a timeout decision; see [automation-approval-timeout.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-approval-timeout.ts:1), [automation-approval-timeout.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-approval-timeout.ts:20), and [automation-approval-timeout.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-approval-timeout.ts:40).
- The repo already has hand-rolled per-chat automation message queueing. `automation_message_queue` stores `chatId`, `messageJson`, `status`, `claimedAt`, and `startedEveSessionId`; see [schema.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/lib/db/schema.ts:616). `claimNextAutomationQueuedMessage(chatId)` checks whether the chat is streaming, selects the oldest queued item for the chat, and atomically updates `queued -> claimed`; see [store.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/lib/automation/store.ts:1835). The workflow wrapper `automationMessageQueueWorkflow(chatId)` claims one item and then starts the Eve turn; see [automation-message-queue.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-message-queue.ts:50), [automation-message-queue.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-message-queue.ts:56), and [automation-message-queue.ts](/home/dana/projects/augment/agents/executor/apps/open-agents/app/workflows/automation-message-queue.ts:122).

## 1. Vercel Workflows / Workflow DevKit

Official docs: https://vercel.com/docs/workflows, https://vercel.com/docs/workflows/pricing, https://workflow-sdk.dev/docs/foundations/streaming, https://workflow-sdk.dev/docs/foundations/hooks, https://vercel.com/kb/guide/what-is-workflowagent.

Current feature set relevant to this design:

- Vercel Workflows is a managed durable platform for JS/TS/Python workflows. Vercel Functions execute workflow/step code; Vercel Queues enqueue and execute those routes; managed persistence stores workflow state and event logs. Source: https://vercel.com/docs/workflows.
- Workflows support `"use workflow"` and `"use step"`, sleeps, hooks, observability, managed persistence, streams, and skew protection. Source: https://vercel.com/docs/workflows.
- Workflow limits: max run duration has no limit; sleep duration has no limit; individual step runtime is still bounded by Vercel Function limits; events per run 25,000; steps per run 10,000; max stream storage size unlimited; stream chunk max 10 MB; stream chunks per second per stream 1,000; managed retention after run completion is Hobby 1 day, Pro 7 days, Enterprise 30 days. Source: https://vercel.com/docs/workflows/pricing.
- Hooks are low-level suspension points. A workflow creates a hook token, awaits it, and external code resumes it with serializable data. Hooks can be deterministic/custom-token and can be iterated with `for await` to receive multiple events over time. Source: https://workflow-sdk.dev/docs/foundations/hooks.
- Webhooks are higher-level hook wrappers with public `/.well-known/workflow/v1/webhook/:token` endpoints and default `202 Accepted` behavior. Source: https://workflow-sdk.dev/docs/foundations/hooks.
- Streams are now a core Workflow primitive. Every run has a default writable stream; steps write via `getWritable()`, clients can consume `run.readable`, and later reconnect by `getRun(runId).getReadable({ startIndex })`. Negative `startIndex` is supported, but accurate pagination over a live stream requires cursor-based access, which docs say is **not yet supported**. Source: https://workflow-sdk.dev/docs/foundations/streaming.
- Workflow stream persistence is backed by the platform world implementation: Vercel deployments use a Redis-based stream; local dev stores chunks on filesystem. Stream data persists across workflow suspension points, and Workflow pricing bills stream data as managed persistence. Sources: https://workflow-sdk.dev/docs/foundations/streaming and https://vercel.com/docs/workflows/pricing.
- Stream operations must happen in steps, not directly in workflow context, because workflow functions must remain deterministic during replay. Source: https://workflow-sdk.dev/docs/foundations/streaming.
- Important retry boundary: when a step returns a stream, the step is considered successful once it returns; later stream errors do not automatically retry the producer step. The consumer must handle stream errors. Source: https://workflow-sdk.dev/docs/foundations/streaming.

Answer to the core durability question: **steps are durable/retryable at step boundaries, not arbitrary mid-function checkpoints.** Workflow can durably stream out chunks while a step runs, and WorkflowAgent can survive function timeout/reconnect by persisting state/stream chunks, but a raw long-running `for await` over an AI provider inside one step is still constrained by individual function duration and will not be automatically resumed mid-loop unless the agent/streaming integration checkpoints the relevant state through Workflow primitives. The docs explicitly bind “max runtime of individual step” to Vercel Functions limits and say steps are retry units; the streaming docs also warn producer stream errors after a step returns do not retry the producer. Sources: https://vercel.com/docs/workflows/pricing and https://workflow-sdk.dev/docs/foundations/streaming.

WorkflowAgent / durable agent overlap:

- `WorkflowAgent` from `@ai-sdk/workflow` runs the AI SDK agent loop in the Workflow runtime. Tool calls marked `"use step"` become durable, retryable Workflow steps; approvals can suspend for hours/days; state survives process restarts/function timeouts. Source: https://vercel.com/kb/guide/what-is-workflowagent.
- `WorkflowAgent.stream()` writes `ModelCallStreamPart` chunks to a Workflow writable; route handlers convert to UI chunks with `createModelCallToUIChunkTransform()`. Source: https://vercel.com/kb/guide/what-is-workflowagent and https://workflow-sdk.dev/docs/foundations/streaming.
- `WorkflowChatTransport` for `useChat` posts to the chat endpoint, reads `x-workflow-run-id`, and if the stream closes without a finish event, reconnects to `{api}/{runId}/stream` with `startIndex` to resume from the last received chunk. Source: https://vercel.com/kb/guide/what-is-workflowagent.

What is missing/uncertain for our chat pipeline:

- Workflows give hook/webhook input into suspended runs and streams out of runs, but the docs do not present a “signal mailbox with strict FIFO per key” primitive. Hooks can be iterated, yet ordering/claim acceptance semantics must be designed.
- Workflow streams resume by chunk `startIndex`, not an application event cursor. Docs say live-stream cursor pagination is not yet supported. Source: https://workflow-sdk.dev/docs/foundations/streaming.

## 2. Vercel Queues

Official docs: https://vercel.com/docs/queues/concepts and https://vercel.com/docs/queues/sdk.

- Vercel Queues is a durable event streaming system with topics, independent consumer groups, push and poll modes, retries, visibility timeouts, idempotency keys, fan-out, and Vercel Function push consumers. Source: https://vercel.com/docs/queues/concepts.
- A topic is a durable append-only log. Messages fan out to every consumer group and are retained until acknowledged or expired; retention is configurable per message from 60 seconds to 7 days, default 24 hours. Source: https://vercel.com/docs/queues/concepts.
- Accepted messages are synchronously written to three availability zones before publish returns. Source: https://vercel.com/docs/queues/concepts.
- Delivery is at-least-once. Consumers must be idempotent because timeouts/failovers can redeliver. Source: https://vercel.com/docs/queues/concepts.
- Push consumers are configured via `vercel.json` `experimentalTriggers` with type `queue/v2beta`; consumer routes are private/internal and only queue infra can invoke them. Source: https://vercel.com/docs/queues/concepts.
- SDK consumers acknowledge automatically on successful handler completion and retry if the handler throws. Source: https://vercel.com/docs/queues/sdk.
- Vercel Queues has no built-in DLQ; poisoned messages are handled in app code via retry callbacks. Source: https://vercel.com/docs/queues/concepts.
- Critical for per-chat serialization: Queues deliver in approximate write order only. The docs explicitly state retried messages can be deprioritized behind new messages and that there is **no FIFO guarantee, even with a single consumer and max concurrency 1**. Source: https://vercel.com/docs/queues/concepts.

Fit for per-chat FIFO single-writer: **not sufficient by itself.** Queues can durably accept sends and invoke consumers, but they do not provide per-key ordering or single-writer session ownership. A queue consumer could wake a Postgres claimant or per-chat workflow, but the serialization invariant remains ours.

## 3. `resumable-stream` + AI SDK `useChat` resume pattern

Official/docs sources: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams and https://github.com/vercel/resumable-stream.

- AI SDK `useChat` has a `resume` option. On mount, it automatically issues `GET /api/chat/[id]/stream` to check for and resume an active stream. Source: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams.
- The AI SDK provides the client-side resume option, the `consumeSseStream` callback, and automatic resume requests. The app still builds storage for chat-to-stream mapping, Redis stream storage, and POST/GET endpoints. Source: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams.
- The pattern uses `resumable-stream` to wrap the outgoing UIMessage SSE stream. The POST handler starts generation, creates a resumable stream ID in `consumeSseStream`, stores `activeStreamId` on the chat, and clears it on completion. The GET handler reads `activeStreamId` and calls `resumeExistingStream`; if none exists, it returns 204. Source: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams.
- The docs use Next `after` so work continues after the response has been sent, allowing the Redis resumable stream to persist even after the original response is returned. Source: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams.
- `resumable-stream` itself is designed around Redis pub/sub and recovery, minimizing common-case overhead to a single `INCR` and `SUBSCRIBE` per stream; it can also be adapted to Redis-compatible clients. Source: https://github.com/vercel/resumable-stream.
- In resumable-stream mode, client abort/refresh/navigation is treated as disconnect, not cancellation. A separate stop endpoint must persist a partial assistant snapshot, cancel active work, and clear `activeStreamId`. Source: https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams.

Does this replace hand-rolled SSE-with-cursor + Postgres event log repair? **Only for active stream replay, not authoritative chat event persistence.** It gives Redis-backed replay/fan-out for an active UIMessage stream and integrates with `useChat`, but the docs still require an app persistence layer to track active streams and messages. It does not provide a Postgres-backed event log, durable post-hoc repair-on-read, long retention beyond Redis/configured stream expiry, or application event cursor semantics. Workflow streams provide a Vercel-managed alternative with run chunk indices, but also not a Postgres event-log cursor.

## 4. Durable agent examples

Official/examples sources: https://vercel.com/kb/guide/what-is-workflowagent, https://workflow-sdk.dev/docs/foundations/streaming, https://vercel.com/blog/a-new-programming-model-for-durable-execution, https://vercel.com/kb/guide/stateful-slack-bots-with-vercel-workflow.

- Vercel documents `WorkflowAgent` as the current durable AI SDK agent path, replacing older Workflow SDK `DurableAgent`. It supports durable tool calls, approvals, callbacks, streaming, and chat transport reconnection. Source: https://vercel.com/kb/guide/what-is-workflowagent.
- Workflow SDK streaming docs include an AI assistant workflow where `WorkflowAgent.stream()` writes model-call chunks into `getWritable<ModelCallStreamPart>()`, and a POST route returns `run.readable.pipeThrough(createModelCallToUIChunkTransform())`. Source: https://workflow-sdk.dev/docs/foundations/streaming.
- Vercel’s durable execution blog says Workflow + AI SDK integration provides durable execution, tool calling, state management, external events/interruptions, and durable streams via `getWritable()`. Source: https://vercel.com/blog/a-new-programming-model-for-durable-execution.
- The stateful Slack bot guide demonstrates a workflow that pauses after each message and resumes via a hook, retaining story state without a separate database. Source: https://vercel.com/kb/guide/stateful-slack-bots-with-vercel-workflow.

Do examples demonstrate queue-serialized sends into a long-running agent session? **Not as a turnkey per-chat FIFO queue.** They demonstrate (1) a durable agent loop with stream resume by run ID/index, and (2) a hook-resumed multi-message workflow pattern. They do not show Vercel Queues providing strict per-chat FIFO into a busy agent session; the Queues docs rule that out as a native ordering guarantee.

## 5. Fluid compute `waitUntil` / `after`

Official docs: https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package and https://vercel.com/docs/functions/limitations.

- For Next.js 15.1+, Vercel recommends Next `after()` over `waitUntil()` for post-response background work. `after()` runs once rendering/response is finished and does not block the response; max duration can be configured with Next `maxDuration`. Source: https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package.
- `waitUntil()` extends the request handler lifetime for the lifetime of a promise, but promises passed to `waitUntil()` have the same timeout as the function itself; if the function times out, those promises are cancelled. Source: https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package.
- Vercel Functions with Fluid Compute have max duration Hobby 300s, Pro/Enterprise 800s GA, 1800s extended beta. Request handler duration includes processing and streaming response time. Source: https://vercel.com/docs/functions/limitations.
- Vercel explicitly says workloads requiring unlimited execution time should use Vercel Workflows, not plain Functions. Source: https://vercel.com/docs/functions/limitations.

Can a route respond `202` and keep draining a stream reliably? **Only within the function max duration.** `after()`/`waitUntil()` is useful for short post-response continuation, logging, Redis resumable-stream pumping, and cleanup, but it is not a durable long-running drain primitive. For turns that must survive function death/timeouts/deployments, use Workflows/WorkflowAgent or hand-rolled durable checkpoints.

## Verdict table

| Planned component | Platform-native option already available | Fit | Recommended stance |
|---|---|---:|---|
| (a) Per-chat single-writer claim + message queue for sends into a busy AI agent session | Workflow hooks can receive/resume messages into a suspended per-chat workflow; Vercel Queues can durably ingest work; Workflow hook `getConflict()` can reserve deterministic tokens; existing repo has Postgres `automation_message_queue` claimant | Partial | Keep a hand-rolled single-writer invariant. Consider replacing ad hoc wakeups with a per-chat Workflow hook loop, but do not rely on Vercel Queues for per-chat FIFO because docs say no strict FIFO, even with one consumer/max concurrency 1. |
| (b) Split send-acceptance from stream-draining so agent turn survives serverless function death; drain resumable by cursor | WorkflowAgent + Workflow streams + WorkflowChatTransport. Runs survive restarts/timeouts; tool calls are durable steps; stream chunks persist and clients reconnect by `runId`/`startIndex` | Strong, with caveats | Prefer WorkflowAgent/Workflow streams for durable agent turns. Avoid one raw long provider-drain step as the only durability boundary; steps are bounded by Function limits and resume at step/checkpoint semantics. |
| (c) SSE fan-out where clients reconnect with cursor and server replays from Postgres event log | AI SDK `useChat resume` + `resumable-stream` for active Redis-backed stream replay; Workflow streams for managed run streams and `startIndex` replay | Partial | Use platform patterns for active stream reconnection. Keep Postgres event log if it is the authoritative durable transcript, multi-client repair source, or needs app-level cursor semantics/retention. Workflow stream `startIndex` is chunk index, not our Postgres event cursor; resumable-stream still requires app persistence. |
| (d) Sweeper cron for abandoned turns | Workflow `sleep()` with no max duration; timeout child workflows; Vercel Cron still possible for broad scans | Strong | Prefer per-turn timeout workflows/sleeps for known deadlines, as repo already does for approval expiry. Keep cron only for defense-in-depth scans, external consistency repair, and rows not owned by a live workflow. |

## Bottom line

Vercel’s 2026 platform meaningfully reduces our custom durable-execution surface: **WorkflowAgent + Workflow streams should be treated as the native durable agent/stream-resume layer**, and Workflow sleeps/hooks can replace many cron/polling and human-input wait loops. The remaining custom work is the chat-domain coordination layer: strict per-chat acceptance ordering, single-writer ownership, authoritative message/event persistence, explicit cancellation semantics, and repair over our chosen transcript store.