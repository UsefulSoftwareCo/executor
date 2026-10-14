import type { ExecutionRejected } from "../contracts/execute.ts";
/** Execution-owned tool invocations and pending interactions. Delivery never owns the continuation. */
import type { CodeMode } from "@opencode-ai/codemode";
import {
  ElicitationFailed,
  toolCallSpan,
  ToolInputs,
  invocationAccounts,
  type ToolCallResult,
  type ToolPending,
} from "@executor-js/sdk/core";
import {
  defaultElicitationLimits,
  exactApprovalElicitation,
  type ElicitationResponse,
  type ElicitationHandler,
} from "apps/contracts";
import { prepareElicitation } from "apps/effect";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Match,
  Option,
  Queue,
  Schema,
  Scope,
  Scheduler,
} from "effect";
import type { McpBackend } from "../contracts/backend.ts";
import {
  ApprovalTooLarge,
  ApprovalUnavailable,
  defaultMcpRuntimeLimits,
  ElicitationRequestId,
  ElicitationResponseInvalid,
  ResumeInput,
  type InteractionId,
  type InteractionTool,
  type ToolInputPending,
  type ExecuteResult,
  type McpExecutionResult,
  type McpLimits,
  type PendingInteraction,
  resumeUnavailableMessage,
  type ResumeUnavailableReason,
} from "../contracts/execute.ts";
import type { BrowserApprovalView, BrowserApprovalAcknowledgement } from "../contracts/browser.ts";
import { programScheduler } from "./program-scheduler.ts";
import { reportFailure } from "./diagnostics.ts";
import {
  executionProgress,
  reportedCalls,
  timeoutDeliveryMs,
  timeoutMessage,
  type ExecutionProgress,
  type Program,
} from "./execute.ts";

class ApprovalDenied extends Schema.TaggedError<ApprovalDenied>()("ApprovalDenied", {}) {}
class ApprovalCancelled extends Schema.TaggedError<ApprovalCancelled>()("ApprovalCancelled", {}) {}
class McpExecutionFailed extends Schema.TaggedError<McpExecutionFailed>()(
  "McpExecutionFailed",
  {},
) {}

/** Why a request stopped being pending before or without a resume answering it. */
type Ended = Exclude<ResumeUnavailableReason, "not-found">;
/** Ended requests are remembered as long as an answer to them can plausibly still arrive. */
const endedRetentionMs = 30 * 60 * 1000;
/** Bounds that memory however many requests a host issues. */
const maxEnded = 4096;

/** Whether a call runs with no account in either scope. */
const accountFree = (accounts: NonNullable<InteractionTool["accounts"]>) =>
  Object.keys(accounts.app).length === 0 && Object.keys(accounts.user ?? {}).length === 0;

/**
 * The asking call's identity. A call without accounts in either scope omits the key; MCP results
 * are JSON.
 */
const interactionTool = (call: {
  readonly app: InteractionTool["app"];
  readonly tool: InteractionTool["tool"];
  readonly accounts?: InteractionTool["accounts"] | undefined;
}): InteractionTool => ({
  app: call.app,
  tool: call.tool,
  ...(call.accounts === undefined || accountFree(call.accounts) ? {} : { accounts: call.accounts }),
});

/**
 * How a run's pending interactions reach a person, which decides what must fit the output budget.
 * Model and browser delivery return the whole interaction as the execute result; browser delivery
 * also adds its review link, a few hundred bytes the budget does not count. Native delivery sends
 * only the prompt, as the client's own elicitation request.
 */
export type PendingTransport = "result" | "prompt";
/**
 * Who answers a policy approval: the user through a pending interaction (`ask`), or the MCP client,
 * which already confirmed the destructive tool call that started the run (`client`).
 */
export type ApprovalMode = "ask" | "client";
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
/** UTF-8 bytes of the JSON a transport sends for this interaction. */
const sentBytes = (transport: PendingTransport, request: PendingInteraction) =>
  jsonBytes(transport === "prompt" ? request.elicitation : request);

type Operation = { readonly waiting: Set<InteractionId> };
type Pending = {
  readonly browserAnswer: Deferred.Deferred<ElicitationResponse | undefined>;
  readonly run: Run;
  readonly respond: (
    input: unknown,
  ) => Effect.Effect<ElicitationResponse, ElicitationResponseInvalid>;
} & (
  | {
      readonly kind: "approval";
      readonly request: typeof ToolPending.Type;
      readonly response: Deferred.Deferred<ToolCallResult, Error>;
      /** The program's call index, reported as awaiting approval until this is answered. */
      readonly call: number | undefined;
    }
  | {
      readonly kind: "input";
      readonly request: typeof ToolInputPending.Type;
      readonly response: Deferred.Deferred<ElicitationResponse, ElicitationFailed>;
      readonly operation: Operation;
    }
);
type Work = (backend: McpBackend<Error>, operation: Operation) => Effect.Effect<void>;
type Event =
  | { readonly kind: "operation"; readonly handle: Work }
  | { readonly kind: "wake" }
  | { readonly kind: "done"; readonly result: typeof ExecuteResult.Type };
type Run = {
  readonly id: string;
  readonly transport: PendingTransport;
  readonly approval: ApprovalMode;
  readonly scheduling: ReturnType<typeof programScheduler>;
  readonly caller: string;
  readonly scope: Scope.Closeable;
  readonly events: Queue.Queue<Event>;
  readonly pending: Map<InteractionId, Pending>;
  readonly operations: Set<Operation>;
  readonly progress: ExecutionProgress;
  /** Completed once when the active-time budget is spent; the program observes it as its timeout. */
  readonly expired: Deferred.Deferred<void>;
  remainingMs: number;
  busy: boolean;
  closed: boolean;
};

/**
 * Programs running in this process, across every execution store in it. On Cloud the process is
 * an isolate that several MCP session objects share, and every program there counts against its
 * one memory limit, parked ones included.
 */
const live = { programs: 0 };
export const runningPrograms = () => live.programs;

/** Both transports drive this bounded, host-owned store. Closing it cancels programs and their tools. */
export const makeExecutions = (
  limits: McpLimits,
  beforeExecute: Effect.Effect<void, ExecutionRejected> = Effect.void,
) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const scheduler = yield* Scheduler.Scheduler;
    const hostScope = yield* Effect.scope;
    const baseContext = Context.make(Clock.Clock, clock).pipe(
      Context.add(Scheduler.Scheduler, scheduler),
    );
    const runs = new Set<Run>();
    /** Ended runs whose tools are still being cancelled; they count toward the execution limit. */
    const closing = new Set<Run>();
    const requests = new Map<InteractionId, Pending>();
    /**
     * Why each recently pending request stopped being pending, kept for its caller only, so a late
     * resume learns whether it was answered, expired or ended rather than only that it is gone.
     */
    const ended = new Map<
      InteractionId,
      { readonly caller: string; readonly reason: Ended; readonly until: number }
    >();
    const unavailable = (
      caller: string,
      requestId: InteractionId,
    ): Extract<McpExecutionResult, { status: "unavailable" }> => {
      const known = ended.get(requestId);
      const reason: ResumeUnavailableReason =
        known === undefined || known.caller !== caller ? "not-found" : known.reason;
      return {
        status: "unavailable",
        requestId,
        reason,
        message: resumeUnavailableMessage(reason),
      };
    };
    const failure = (
      run: Run,
      kind: CodeMode.DiagnosticKind,
      message: string,
    ): McpExecutionResult & { status: "completed" } => ({
      status: "completed",
      execution: { ok: false, error: { kind, message }, toolCalls: reportedCalls(run.progress) },
      unavailableApps: run.progress.unavailableApps,
    });
    /** The program did not deliver its own timeout result; report what the driver recorded. */
    const timedOut = (run: Run) =>
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "executor.timeout.phase": run.progress.phase,
          "executor.timeout.delivery": "driver",
        });
        return failure(
          run,
          "TimeoutExceeded",
          timeoutMessage(limits.timeoutMs, run.progress.phase),
        );
      });
    const wake = (run: Run) => Queue.offer(run.events, { kind: "wake" });
    /** Stop offering a request. Only the first end of a still pending request is remembered. */
    const forget = (pending: Pending, reason: Ended) => {
      const id = pending.request.requestId;
      if (requests.get(id) === pending) {
        // Map order is insertion order: drop the oldest records beyond the bound.
        ended.delete(id);
        ended.set(id, {
          caller: pending.run.caller,
          reason,
          until: clock.currentTimeMillisUnsafe() + endedRetentionMs,
        });
        for (const oldest of ended.keys()) {
          if (ended.size <= maxEnded) break;
          ended.delete(oldest);
        }
      }
      requests.delete(id);
      pending.run.pending.delete(pending.request.requestId);
      // Wake collectors atomically with removal; an already recorded answer is never overwritten.
      Deferred.doneUnsafe(pending.browserAnswer, Effect.succeed(undefined));
    };
    /** End the run at once: no new work, answers or resumes. Returns false if it had already ended. */
    const detach = (run: Run) => {
      if (run.closed) return false;
      run.closed = true;
      run.scheduling.resume();
      for (const pending of run.pending.values()) forget(pending, "ended");
      runs.delete(run);
      return true;
    };
    const stop = (run: Run) =>
      Effect.suspend(() => (detach(run) ? Scope.close(run.scope, Exit.void) : Effect.void));
    // Closing a run interrupts its unfinished tools and waits for their cancellation. A result
    // or a caller's cancellation never waits for that: the host scope owns it, shutting the host
    // down still waits for it, and closing runs count toward the execution limit until done.
    const release = (run: Run) =>
      Effect.suspend(() => {
        if (!detach(run)) return Effect.void;
        closing.add(run);
        return Effect.forkIn(
          Effect.uninterruptible(
            Scope.close(run.scope, Exit.void).pipe(
              Effect.ensuring(Effect.sync(() => closing.delete(run))),
            ),
          ),
          hostScope,
        ).pipe(Effect.asVoid);
      });
    /** Report a call as awaiting approval while it waits, and as running once it is answered. */
    const approvalWait = (run: Run, index: number | undefined, waiting: boolean) => {
      const call = index === undefined ? undefined : run.progress.calls[index];
      if (call === undefined) return;
      if (waiting && call.outcome === "running") call.outcome = "awaiting-approval";
      if (!waiting && call.outcome === "awaiting-approval") call.outcome = "running";
    };
    /** The active-time budget is spent: nothing new may start, park or resume. */
    const expired = (run: Run) => Deferred.isDoneUnsafe(run.expired);
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...runs], stop, { concurrency: "unbounded", discard: true }),
    );
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("1 second");
          const now = yield* Clock.currentTimeMillis;
          for (const [id, { until }] of ended) if (until <= now) ended.delete(id);
          for (const run of runs) {
            const lapsed = [...run.pending.values()].filter(
              ({ request }) => request.expiresAt <= now,
            );
            for (const pending of lapsed) forget(pending, "expired");
            if (lapsed.length > 0) yield* stop(run);
          }
        }
      }),
      hostScope,
    ).pipe(Effect.provideContext(baseContext));

    const record = (pending: Pending) =>
      Effect.gen(function* () {
        if (pending.run.closed || expired(pending.run))
          return yield* new ApprovalUnavailable({ reason: "ended" });
        pending.run.pending.set(pending.request.requestId, pending);
        requests.set(pending.request.requestId, pending);
        yield* wake(pending.run);
      });

    const elicitation =
      (run: Run, operation: Operation, tool: InteractionTool): ElicitationHandler =>
      (input, signal) =>
        Effect.gen(function* () {
          const form = yield* prepareElicitation(input);
          if (signal.aborted || run.closed || expired(run))
            return yield* new ElicitationFailed({ reason: "unavailable" });
          const response = yield* Deferred.make<ElicitationResponse, ElicitationFailed>();
          const request: typeof ToolInputPending.Type = {
            status: "input-required",
            requestId: ElicitationRequestId.make(`elc_${crypto.randomUUID()}`),
            tool,
            elicitation: form.request,
            expiresAt: (yield* Clock.currentTimeMillis) + defaultElicitationLimits.timeoutMs,
          };
          // The app's question cannot reach anyone, so its request is invalid. The app learns only
          // that; the span keeps the size, for operators.
          const bytes = sentBytes(run.transport, request);
          if (bytes > limits.maxOutputBytes) {
            yield* Effect.annotateCurrentSpan({
              "executor.elicitation.bytes": bytes,
              "executor.elicitation.limit": limits.maxOutputBytes,
            });
            return yield* new ElicitationFailed({ reason: "invalid-request" });
          }
          const pending: Pending = {
            kind: "input",
            browserAnswer: yield* Deferred.make<ElicitationResponse | undefined>(),
            request,
            response,
            run,
            operation,
            respond: (input) =>
              form.respond(input).pipe(Effect.mapError(() => new ElicitationResponseInvalid())),
          };
          operation.waiting.add(request.requestId);
          return yield* record(pending).pipe(
            // Recording fails only once the run has ended.
            Effect.mapError(() => new ElicitationFailed({ reason: "unavailable" })),
            Effect.andThen(Deferred.await(response)),
            Effect.raceFirst(
              Effect.callback<never>((resume) => {
                const abort = () => resume(Effect.interrupt);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
                return Effect.sync(() => signal.removeEventListener("abort", abort));
              }),
            ),
            Effect.ensuring(
              Effect.gen(function* () {
                const abandoned = requests.get(request.requestId) === pending;
                forget(pending, "ended");
                operation.waiting.delete(request.requestId);
                // A transport can cancel a question after its drive has returned.
                // Close from the host scope: this callback is itself owned by run.scope.
                if (abandoned && !run.busy && !run.closed) {
                  yield* Effect.forkIn(stop(run), hostScope);
                } else yield* wake(run);
              }),
            ),
          );
        });

    // An admitted operation owns its resources until completion, including while a tool awaits input.
    // New operations and answers always use the currently driving request's backend.
    const launch = (run: Run, backend: McpBackend<Error>, work: Work) =>
      Effect.gen(function* () {
        const operation: Operation = { waiting: new Set() };
        run.operations.add(operation);
        yield* Effect.scoped(work(backend, operation)).pipe(
          Effect.ensuring(
            Effect.sync(() => run.operations.delete(operation)).pipe(Effect.andThen(wake(run))),
          ),
          Effect.forkIn(run.scope),
        );
      });

    /**
     * The approval request as `run` sends it. A native client is sent only the prompt, so it shows
     * the exact arguments whenever that prompt fits the budget, and the saved shortened one
     * otherwise. A request over the budget is never offered: the saved call is cancelled, so it can
     * never run, and the call fails with the request's size.
     */
    /**
     * Accept a policy approval at once, for a run whose MCP client already confirmed the call. The
     * approved call runs as a resumed one does, so its failures reach the caller the same way.
     */
    const approveNow = (
      run: Run,
      backend: McpBackend<Error>,
      operation: Operation,
      request: typeof ToolPending.Type,
    ): Effect.Effect<ToolCallResult, Error> =>
      backend
        .resumeInvocation(
          request,
          { action: "accept" },
          {
            elicitation: elicitation(
              run,
              operation,
              interactionTool({
                app: request.invocation.app,
                tool: request.invocation.tool,
                accounts: invocationAccounts(request.invocation),
              }),
            ),
          },
        )
        .pipe(
          Effect.flatMap((result) =>
            Match.value(result).pipe(
              Match.when({ status: "completed" }, (result) => Effect.succeed(result)),
              Match.when({ status: "denied" }, () => Effect.fail(new ApprovalDenied())),
              Match.when({ status: "cancelled" }, () => Effect.fail(new ApprovalCancelled())),
              Match.when(
                { status: "failed", reason: "execution-failed", context: "unconfirmed" },
                () => Effect.fail(new ApprovalUnavailable({ reason: "context-unconfirmed" })),
              ),
              Match.when({ status: "failed", reason: "execution-failed" }, ({ error }) =>
                Effect.fail(error),
              ),
              Match.when({ status: "failed" }, ({ reason }) =>
                Effect.fail(new ApprovalUnavailable({ reason })),
              ),
              Match.when({ status: "already-consumed" }, () =>
                Effect.fail(new ApprovalUnavailable({ reason: "answered" })),
              ),
              Match.exhaustive,
            ),
          ),
        );
    const offer = (
      run: Run,
      backend: McpBackend<Error>,
      saved: typeof ToolPending.Type,
    ): Effect.Effect<typeof ToolPending.Type, ApprovalTooLarge> =>
      Effect.gen(function* () {
        const exact =
          run.transport === "prompt"
            ? exactApprovalElicitation(
                saved.invocation.tool,
                saved.invocation.input,
                limits.maxOutputBytes,
              )
            : undefined;
        const request =
          exact !== undefined && jsonBytes(exact) <= limits.maxOutputBytes
            ? { ...saved, elicitation: exact }
            : saved;
        const bytes = sentBytes(run.transport, request);
        if (bytes <= limits.maxOutputBytes) return request;
        // Its ID never leaves the host, but consuming it means no answer could ever run it.
        yield* Effect.ignore(backend.resumeInvocation(saved, { action: "cancel" }), {
          log: "Warn",
          message: "Cancelling an oversized approval request failed",
        });
        return yield* Effect.fail(
          new ApprovalTooLarge({
            tool: saved.invocation.tool,
            bytes,
            limit: limits.maxOutputBytes,
          }),
        );
      });

    const broker = (run: Run): McpBackend<Error> => {
      const exchange = <A>(
        work: (backend: McpBackend<Error>, operation: Operation) => Effect.Effect<A, Error>,
        deliver: (value: A, response: Deferred.Deferred<A, Error>) => Effect.Effect<void, Error> = (
          value,
          response,
        ) => Deferred.succeed(response, value).pipe(Effect.asVoid),
      ) =>
        Effect.gen(function* () {
          // Propagate only trace parentage across the broker, never captured authority.
          const parent = yield* Effect.currentSpan.pipe(Effect.option);
          const queued = yield* Clock.currentTimeMillis;
          const response = yield* Deferred.make<A, Error>();
          const cancelled = yield* Deferred.make<void>();
          const handle: Work = (backend, operation) =>
            Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan(
                "executor.dispatch.wait_ms",
                (yield* Clock.currentTimeMillis) - queued,
              );
              return yield* work(backend, operation);
            }).pipe(
              Effect.withSpan("mcp.backend.dispatch", { parent: Option.getOrUndefined(parent) }),
              Effect.flatMap((value) => deliver(value, response)),
              Effect.catch((error) => Deferred.fail(response, error)),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Deferred.fail(response, new McpExecutionFailed()),
              ),
              Effect.raceFirst(Deferred.await(cancelled).pipe(Effect.andThen(Effect.interrupt))),
              Effect.asVoid,
            );
          yield* Queue.offer(run.events, { kind: "operation", handle });
          return yield* Deferred.await(response).pipe(
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          );
        });
      return {
        listSkills: (input, options) => exchange((backend) => backend.listSkills(input, options)),
        readSkill: (input) => exchange((backend) => backend.readSkill(input)),
        listApps: (input) => exchange((backend) => backend.listApps(input)),
        listAccounts: (input) => exchange((backend) => backend.listAccounts(input)),
        listTools: (input, options) => exchange((backend) => backend.listTools(input, options)),
        searchableTools: (input, options) =>
          exchange((backend) => backend.searchableTools(input, options)),
        searchTools: (input) => exchange((backend) => backend.searchTools(input)),
        eventDefinitions: (input) => exchange((backend) => backend.eventDefinitions(input)),
        findEventSubscription: (key) => exchange((backend) => backend.findEventSubscription(key)),
        subscribeEvent: (input) => exchange((backend) => backend.subscribeEvent(input)),
        unsubscribeEvent: (input) => exchange((backend) => backend.unsubscribeEvent(input)),
        callTool: (input) =>
          Effect.flatMap(Effect.fiberId, (fiber) => {
            const call = run.progress.callFibers.get(fiber);
            return exchange(
              (backend, operation) =>
                backend
                  .callTool(input, {
                    elicitation: elicitation(run, operation, interactionTool(input)),
                  })
                  .pipe(
                    toolCallSpan("mcp.tool.call", {
                      attributes: {
                        "executor.app.id": input.app,
                        "executor.tool.name": input.tool,
                      },
                    }),
                    Effect.flatMap((result): Effect.Effect<ToolCallResult, Error> =>
                      result.status === "completed"
                        ? Effect.succeed(result)
                        : run.approval === "client"
                          ? approveNow(run, backend, operation, result)
                          : offer(run, backend, result),
                    ),
                  ),
              (result, response) => {
                if (result.status === "completed")
                  return Deferred.succeed(response, result).pipe(Effect.asVoid);
                return record({
                  kind: "approval",
                  browserAnswer: Deferred.makeUnsafe<ElicitationResponse | undefined>(),
                  request: result,
                  response,
                  run,
                  call,
                  respond: (input) =>
                    Schema.decodeUnknownEffect(ToolInputs.resume.fields.response)(input).pipe(
                      Effect.mapError(() => new ElicitationResponseInvalid()),
                    ),
                }).pipe(Effect.tap(() => Effect.sync(() => approvalWait(run, call, true))));
              },
            );
          }),
        authorizeElicitation: () => Effect.fail(new ElicitationFailed({ reason: "unavailable" })),
        // Only the execution manager answers approvals; program code never reaches this.
        resumeInvocation: () => Effect.die("A program cannot resume an approval request"),
      };
    };

    // The program runs only while a request drives it, and that request reports what it found:
    // the request that started the program may have ended, and its reporter with it.
    // Taking and reporting are one uninterruptible step: cancellation, a client disconnect or the
    // timeout race could otherwise stop the batch after taking it, and the finalizer would find no
    // failures left. Reporters run synchronously and only buffer, so the step is bounded.
    const report = (run: Run) =>
      Effect.uninterruptible(
        Effect.suspend(() =>
          Effect.forEach(run.progress.failures.splice(0), reportFailure, { discard: true }),
        ),
      );

    const drive = (
      run: Run,
      backend: McpBackend<Error>,
      begin: Effect.Effect<void> = Effect.void,
    ): Effect.Effect<McpExecutionResult> =>
      Effect.gen(function* () {
        run.busy = true;
        run.scheduling.resume();
        const started = yield* Clock.currentTimeMillis;
        const loop = Effect.gen(function* () {
          yield* begin;
          yield* wake(run);
          while (true) {
            const event = yield* Queue.take(run.events);
            yield* report(run);
            if (run.closed)
              return expired(run)
                ? yield* timedOut(run)
                : failure(
                    run,
                    "ExecutionFailure",
                    "Execution ended; its continuation is unavailable",
                  );
            const completed = yield* Match.value(event).pipe(
              // After the deadline, work the program queued before its interruption never starts.
              Match.when({ kind: "operation" }, ({ handle }) =>
                expired(run)
                  ? Effect.succeed(undefined)
                  : launch(run, backend, handle).pipe(Effect.as(undefined)),
              ),
              Match.when({ kind: "done" }, ({ result }) =>
                release(run).pipe(Effect.as({ status: "completed" as const, ...result })),
              ),
              Match.when({ kind: "wake" }, () => Effect.succeed(undefined)),
              Match.exhaustive,
            );
            if (completed !== undefined) return completed;
            // Calls awaiting input remain owned by run.scope. Other admitted work must finish before parking.
            // An expired run never parks: it only waits for the program's own timeout result.
            if (
              !expired(run) &&
              run.pending.size > 0 &&
              [...run.operations].every((operation) => operation.waiting.size > 0)
            ) {
              yield* Effect.yieldNow;
              if (!expired(run) && (yield* Queue.size(run.events)) === 0) {
                const first = run.pending.values().next().value;
                if (first !== undefined) {
                  run.scheduling.pause();
                  return first.request;
                }
              }
            }
          }
        });
        return yield* loop.pipe(
          Effect.raceFirst(
            Effect.sleep(Math.max(0, run.remainingMs)).pipe(
              Effect.andThen(Deferred.succeed(run.expired, undefined)),
              // The program normally delivers its own timeout result, with logs, well within this.
              Effect.andThen(Effect.sleep(timeoutDeliveryMs)),
              Effect.andThen(release(run)),
              Effect.andThen(timedOut(run)),
            ),
          ),
          Effect.onInterrupt(() => stop(run)),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* report(run);
              run.remainingMs -= Math.max(0, (yield* Clock.currentTimeMillis) - started);
              run.busy = false;
              // A run that parked as its budget ran out must not resume before its timer fires.
              if (run.remainingMs <= 0) yield* Deferred.succeed(run.expired, undefined);
            }),
          ),
        );
      });

    const current = (caller: string, id: InteractionId) =>
      Effect.gen(function* () {
        const pending = requests.get(id);
        if (pending === undefined || pending.run.caller !== caller) return undefined;
        if (pending.request.expiresAt <= (yield* Clock.currentTimeMillis)) {
          forget(pending, "expired");
          yield* release(pending.run);
          return undefined;
        }
        return pending;
      });
    return {
      /** Why the caller has no such request to answer. */
      unavailable: (caller: string, id: InteractionId) =>
        Effect.sync(() => unavailable(caller, id)),
      /** Inspect a caller-owned live request, including one whose browser answer is recorded. */
      pendingInteraction: (caller: string, id: InteractionId) =>
        current(caller, id).pipe(Effect.map((pending) => pending?.request)),
      /** Read the exact interaction without creating a second approval store. */
      browserView: (caller: string, id: InteractionId): Effect.Effect<BrowserApprovalView> =>
        Effect.gen(function* () {
          const pending = yield* current(caller, id);
          if (pending === undefined) return { status: "unavailable" };
          return (yield* Deferred.isDone(pending.browserAnswer))
            ? { status: "answered" }
            : { status: "pending", request: pending.request };
        }),
      /** Validate before recording. A browser answer does not consume or execute the pending invocation. */
      answerInBrowser: (
        caller: string,
        id: InteractionId,
        input: ElicitationResponse,
      ): Effect.Effect<BrowserApprovalAcknowledgement, ElicitationResponseInvalid> =>
        Effect.gen(function* () {
          const pending = yield* current(caller, id);
          if (pending === undefined) return { status: "unavailable" };
          if (yield* Deferred.isDone(pending.browserAnswer)) return { status: "answered" };
          const response = yield* pending.respond(input);
          if ((yield* current(caller, id)) !== pending) return { status: "unavailable" };
          yield* Deferred.succeed(pending.browserAnswer, response);
          return { status: "answered" };
        }),
      /** Wait without claiming the program. Cancellation or a polling deadline leaves the interaction intact. */
      browserAnswer: (caller: string, id: InteractionId, pollMs: number) =>
        Effect.gen(function* () {
          const pending = yield* current(caller, id);
          if (pending === undefined) return undefined;
          return yield* Deferred.await(pending.browserAnswer).pipe(
            Effect.timeoutOrElse({
              duration: Math.max(
                0,
                Math.min(pollMs, pending.request.expiresAt - (yield* Clock.currentTimeMillis)),
              ),
              orElse: () => Effect.succeed(undefined),
            }),
          );
        }),
      /** Discard all interactions and live work for the caller's program, without awaiting cleanup. */
      discard: (caller: string, requestId: InteractionId): Effect.Effect<void> =>
        Effect.suspend(() => {
          const pending = requests.get(requestId);
          return pending !== undefined && pending.run.caller === caller
            ? release(pending.run)
            : Effect.void;
        }),
      /**
       * Start one program or batch of direct calls. Policy consent and tool input return the same
       * pending-interaction union.
       */
      execute: (
        caller: string,
        backend: McpBackend<Error>,
        work: Program,
        transport: PendingTransport,
        approval: ApprovalMode = "ask",
      ): Effect.Effect<McpExecutionResult, ExecutionRejected> =>
        Effect.gen(function* () {
          const admitted = () => runs.size + closing.size < defaultMcpRuntimeLimits.maxExecutions;
          if (!admitted()) {
            yield* Effect.annotateCurrentSpan("executor.execution.closing", closing.size);
            return { status: "capacity-exceeded" };
          }
          const run: Run = {
            id: crypto.randomUUID(),
            transport,
            approval,
            caller,
            scheduling: programScheduler(scheduler),
            scope: yield* Scope.make(),
            events: yield* Queue.unbounded<Event>(),
            pending: new Map(),
            operations: new Set(),
            progress: executionProgress(),
            expired: yield* Deferred.make<void>(),
            remainingMs: limits.timeoutMs,
            busy: false,
            closed: false,
          };
          if (!admitted()) {
            yield* Scope.close(run.scope, Exit.void);
            return { status: "capacity-exceeded" };
          }
          runs.add(run);
          yield* Effect.annotateCurrentSpan("executor.execution.id", run.id);
          // Ends at once, so it is exported even when the process dies while the program runs.
          yield* Effect.withSpan(Effect.void, "mcp.execution.started", {
            attributes: {
              "executor.execution.id": run.id,
              "executor.execution.concurrent": live.programs,
            },
          });
          yield* beforeExecute.pipe(
            Effect.onError(() => stop(run)),
            Effect.onInterrupt(() => stop(run)),
          );
          const program = Effect.acquireUseRelease(
            Effect.sync(() => {
              live.programs += 1;
            }),
            () => work(broker(run), limits, Deferred.await(run.expired), run.progress),
            () =>
              Effect.sync(() => {
                live.programs -= 1;
              }),
          ).pipe(
            Effect.onExit((exit) =>
              Queue.offer(run.events, {
                kind: "done",
                result: Exit.isSuccess(exit)
                  ? exit.value
                  : failure(
                      run,
                      "ExecutionFailure",
                      "Execution ended; its continuation is unavailable",
                    ),
              }),
            ),
          );
          return yield* Effect.forkIn(program, run.scope).pipe(
            Effect.provideContext(
              Context.add(baseContext, Scheduler.Scheduler, run.scheduling.scheduler),
            ),
            Effect.andThen(drive(run, backend)),
            Effect.onInterrupt(() => stop(run)),
          );
        }),
      /** Validate, claim and answer one interaction. Neither variant reruns the program or replays results. */
      resume: (
        caller: string,
        backend: McpBackend<Error>,
        unparsed: typeof ResumeInput.Type,
      ): Effect.Effect<McpExecutionResult, ElicitationResponseInvalid> =>
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(ResumeInput)(unparsed, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError(() => new ElicitationResponseInvalid()));
          const pending = requests.get(input.requestId);
          if (pending === undefined || pending.run.caller !== caller)
            return unavailable(caller, input.requestId);
          const response = yield* pending.respond(input.response);
          const run = pending.run;
          yield* Effect.annotateCurrentSpan("executor.execution.id", run.id);
          if (pending.request.expiresAt <= (yield* Clock.currentTimeMillis)) {
            forget(pending, "expired");
            yield* release(run);
            return unavailable(caller, input.requestId);
          }
          if (requests.get(input.requestId) !== pending)
            return unavailable(caller, input.requestId);
          // A run parks only before its deadline; never let an answer start work after it.
          if (expired(run)) {
            yield* release(run);
            return unavailable(caller, input.requestId);
          }
          if (run.busy) return { status: "busy", requestId: input.requestId };
          run.busy = true;
          forget(pending, "answered");
          if (pending.kind === "approval") approvalWait(run, pending.call, false);
          const begin = Match.value(pending).pipe(
            Match.when({ kind: "approval" }, (pending) =>
              launch(run, backend, (active, operation) =>
                active
                  .resumeInvocation(pending.request, response, {
                    elicitation: elicitation(
                      run,
                      operation,
                      interactionTool({
                        app: pending.request.invocation.app,
                        tool: pending.request.invocation.tool,
                        accounts: invocationAccounts(pending.request.invocation),
                      }),
                    ),
                  })
                  .pipe(
                    // The approved call runs here, so this span carries its Executor time.
                    toolCallSpan("mcp.tool.resume", {
                      attributes: {
                        "executor.app.id": pending.request.invocation.app,
                        "executor.tool.name": pending.request.invocation.tool,
                      },
                    }),
                    Effect.flatMap((result) =>
                      Match.value(result).pipe(
                        Match.when({ status: "completed" }, (result) =>
                          Deferred.succeed(pending.response, result),
                        ),
                        Match.when({ status: "denied" }, () =>
                          Deferred.fail(pending.response, new ApprovalDenied()),
                        ),
                        Match.when({ status: "cancelled" }, () =>
                          Deferred.fail(pending.response, new ApprovalCancelled()),
                        ),
                        // Storage failed before Executor could confirm the reviewed call, so it was not resumed.
                        Match.when(
                          { status: "failed", reason: "execution-failed", context: "unconfirmed" },
                          () =>
                            Deferred.fail(
                              pending.response,
                              new ApprovalUnavailable({ reason: "context-unconfirmed" }),
                            ),
                        ),
                        // Resuming the approved call failed: the program sees that failure, as for a live call.
                        Match.when({ status: "failed", reason: "execution-failed" }, ({ error }) =>
                          Deferred.fail(pending.response, error),
                        ),
                        Match.when({ status: "failed" }, ({ reason }) =>
                          Deferred.fail(pending.response, new ApprovalUnavailable({ reason })),
                        ),
                        Match.when({ status: "already-consumed" }, () =>
                          Deferred.fail(
                            pending.response,
                            new ApprovalUnavailable({ reason: "answered" }),
                          ),
                        ),
                        Match.exhaustive,
                      ),
                    ),
                    Effect.catch((error) => Deferred.fail(pending.response, error)),
                    Effect.catchCause((cause) =>
                      Cause.hasInterrupts(cause)
                        ? Effect.interrupt
                        : Deferred.fail(pending.response, new McpExecutionFailed()),
                    ),
                    Effect.asVoid,
                  ),
              ),
            ),
            Match.when({ kind: "input" }, (pending) =>
              backend.authorizeElicitation(pending.request.tool).pipe(
                Effect.matchEffect({
                  onSuccess: () => Deferred.succeed(pending.response, response),
                  onFailure: (error) => Deferred.fail(pending.response, error),
                }),
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.interrupt
                    : Deferred.fail(
                        pending.response,
                        new ElicitationFailed({ reason: "transport" }),
                      ),
                ),
                Effect.ensuring(
                  Effect.sync(() => pending.operation.waiting.delete(pending.request.requestId)),
                ),
                Effect.asVoid,
              ),
            ),
            Match.exhaustive,
          );
          return yield* drive(run, backend, begin);
        }),
    };
  });
