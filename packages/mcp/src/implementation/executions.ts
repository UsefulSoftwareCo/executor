import type { ExecutionRejected } from "../contracts/execute.ts";
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
import { CurrentMcpExecution, ToolCallRecorded, type McpBackend } from "../contracts/backend.ts";
import {
  ApprovalUnavailable,
  defaultMcpRuntimeLimits,
  ElicitationRequestId,
  ElicitationResponseInvalid,
  issuedInteractionId,
  ResumeInput,
  type InteractionEnd,
  type InteractionId,
  type InteractionRecords,
  type OpenInteraction,
  type InteractionTool,
  type ToolInputPending,
  type ExecuteResult,
  type McpExecutionResult,
  type McpLimits,
  resumeUnavailableMessage,
  type ResumeUnavailableReason,
} from "../contracts/execute.ts";
import type { BrowserApprovalView, BrowserApprovalAcknowledgement } from "../contracts/browser.ts";
import { programScheduler } from "./program-scheduler.ts";
import { failureReference, reportFailure } from "./diagnostics.ts";
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

type Ended = InteractionEnd;
const endedRetentionMs = 30 * 60 * 1000;
const maxEnded = 4096;

const accountFree = (accounts: NonNullable<InteractionTool["accounts"]>) =>
  Object.keys(accounts.app).length === 0 && Object.keys(accounts.user ?? {}).length === 0;

const interactionTool = (call: {
  readonly app: InteractionTool["app"];
  readonly tool: InteractionTool["tool"];
  readonly accounts?: InteractionTool["accounts"] | undefined;
}): InteractionTool => ({
  app: call.app,
  tool: call.tool,
  ...(call.accounts === undefined || accountFree(call.accounts) ? {} : { accounts: call.accounts }),
});

export type PendingTransport = "result" | "prompt";
export type ApprovalMode = "ask" | "client";
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const exactPromptBytes = 100_000;

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
  readonly expired: Deferred.Deferred<void>;
  remainingMs: number;
  busy: boolean;
  closed: boolean;
};

const live = { programs: 0 };
export const runningPrograms = () => live.programs;

export const makeExecutions = (
  limits: McpLimits,
  beforeExecute: Effect.Effect<void, ExecutionRejected> = Effect.void,
  records?: InteractionRecords,
) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const scheduler = yield* Scheduler.Scheduler;
    const hostScope = yield* Effect.scope;
    const baseContext = Context.make(Clock.Clock, clock).pipe(
      Context.add(Scheduler.Scheduler, scheduler),
    );
    const runs = new Set<Run>();
    const closing = new Set<Run>();
    const requests = new Map<InteractionId, Pending>();
    const ended = new Map<
      InteractionId,
      { readonly caller: string; readonly reason: Ended; readonly until: number }
    >();
    const reasonFor = (caller: string, requestId: InteractionId) => {
      if (!issuedInteractionId.test(requestId)) return "malformed" as const;
      const known = ended.get(requestId);
      if (known !== undefined) return known.caller === caller ? known.reason : "not-found";
      const issued = records?.read(requestId);
      if (issued === undefined || issued.caller !== caller) return "not-found";
      return issued.end ?? "lost";
    };
    const open = (caller: string, now: number): OpenInteraction[] =>
      [...requests.values()]
        .filter((pending) => pending.run.caller === caller && pending.request.expiresAt > now)
        .map(({ request }) =>
          request.status === "approval-required"
            ? {
                requestId: request.requestId,
                status: request.status,
                app: request.invocation.app,
                tool: request.invocation.tool,
                expiresAt: request.expiresAt,
              }
            : {
                requestId: request.requestId,
                status: request.status,
                app: request.tool.app,
                tool: request.tool.tool,
                expiresAt: request.expiresAt,
              },
        );
    const unavailable = (
      caller: string,
      requestId: InteractionId,
    ): Extract<McpExecutionResult, { status: "unavailable" }> => {
      const now = clock.currentTimeMillisUnsafe();
      const reason: ResumeUnavailableReason = reasonFor(caller, requestId);
      return {
        status: "unavailable",
        requestId,
        reason,
        message: resumeUnavailableMessage(reason),
        pending: open(caller, now),
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
    const forget = (pending: Pending, reason: Ended) => {
      const id = pending.request.requestId;
      if (requests.get(id) === pending) {
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
        records?.ended(id, reason);
      }
      requests.delete(id);
      pending.run.pending.delete(pending.request.requestId);
      Deferred.doneUnsafe(pending.browserAnswer, Effect.succeed(undefined));
    };
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
    const approvalWait = (run: Run, index: number | undefined, waiting: boolean) => {
      const call = index === undefined ? undefined : run.progress.calls[index];
      if (call === undefined) return;
      if (waiting && call.outcome === "running") call.outcome = "awaiting-approval";
      if (!waiting && call.outcome === "awaiting-approval") call.outcome = "running";
    };
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
        records?.issued(pending.request.requestId, pending.run.caller, pending.request.expiresAt);
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
                if (abandoned && !run.busy && !run.closed) {
                  yield* Effect.forkIn(stop(run), hostScope);
                } else yield* wake(run);
              }),
            ),
          );
        });

    const launch = (run: Run, backend: McpBackend<Error>, work: Work) =>
      Effect.gen(function* () {
        const operation: Operation = { waiting: new Set() };
        run.operations.add(operation);
        yield* Effect.scoped(work(backend, operation)).pipe(
          Effect.provideService(CurrentMcpExecution, run.id),
          Effect.ensuring(
            Effect.sync(() => run.operations.delete(operation)).pipe(Effect.andThen(wake(run))),
          ),
          Effect.forkIn(run.scope),
        );
      });

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
    const offer = (run: Run, saved: typeof ToolPending.Type): typeof ToolPending.Type => {
      if (run.transport !== "prompt") return saved;
      const exact = exactApprovalElicitation(
        saved.invocation.tool,
        saved.invocation.input,
        exactPromptBytes,
      );
      return exact !== undefined && jsonBytes(exact) <= exactPromptBytes
        ? { ...saved, elicitation: exact }
        : saved;
    };

    const broker = (run: Run): McpBackend<Error> => {
      const exchange = <A>(
        work: (backend: McpBackend<Error>, operation: Operation) => Effect.Effect<A, Error>,
        deliver: (value: A, response: Deferred.Deferred<A, Error>) => Effect.Effect<void, Error> = (
          value,
          response,
        ) => Deferred.succeed(response, value).pipe(Effect.asVoid),
      ) =>
        Effect.gen(function* () {
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
        bundleSkills: (input, options) =>
          exchange((backend) => backend.bundleSkills(input, options)),
        readSkill: (input) => exchange((backend) => backend.readSkill(input)),
        listApps: (input) => exchange((backend) => backend.listApps(input)),
        listAccounts: (input) => exchange((backend) => backend.listAccounts(input)),
        listTools: (input, options) => exchange((backend) => backend.listTools(input, options)),
        searchableTools: (input, options) =>
          exchange((backend) => backend.searchableTools(input, options)),
        searchTools: (input) => exchange((backend) => backend.searchTools(input)),
        findEventSubscription: (key) => exchange((backend) => backend.findEventSubscription(key)),
        subscribeEvent: (input) => exchange((backend) => backend.subscribeEvent(input)),
        unsubscribeEvent: (input) => exchange((backend) => backend.unsubscribeEvent(input)),
        callTool: (input) =>
          Effect.gen(function* () {
            const call = run.progress.callFibers.get(yield* Effect.fiberId);
            const recorded = yield* ToolCallRecorded;
            return yield* exchange(
              (backend, operation) =>
                backend
                  .callTool(input, {
                    elicitation: elicitation(run, operation, interactionTool(input)),
                  })
                  .pipe(
                    Effect.provideService(ToolCallRecorded, recorded),
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
                          : Effect.succeed(offer(run, result)),
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
        resumeInvocation: () => Effect.die("A program cannot resume an approval request"),
      };
    };

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
        run.progress.reference = yield* failureReference;
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
      live: () => runs.size,
      holds: (caller: (id: string) => boolean) => {
        for (const run of runs) if (caller(run.caller)) return true;
        return false;
      },
      unavailable: (caller: string, id: InteractionId) =>
        Effect.sync(() => unavailable(caller, id)),
      pendingInteraction: (caller: string, id: InteractionId) =>
        current(caller, id).pipe(Effect.map((pending) => pending?.request)),
      browserView: (caller: string, id: InteractionId): Effect.Effect<BrowserApprovalView> =>
        Effect.gen(function* () {
          const pending = yield* current(caller, id);
          if (pending === undefined) return { status: "unavailable" };
          return (yield* Deferred.isDone(pending.browserAnswer))
            ? { status: "answered" }
            : { status: "pending", request: pending.request };
        }),
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
      discard: (caller: string, requestId: InteractionId): Effect.Effect<void> =>
        Effect.suspend(() => {
          const pending = requests.get(requestId);
          return pending !== undefined && pending.run.caller === caller
            ? release(pending.run)
            : Effect.void;
        }),
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
            progress: executionProgress(yield* failureReference),
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
                        Match.when(
                          { status: "failed", reason: "execution-failed", context: "unconfirmed" },
                          () =>
                            Deferred.fail(
                              pending.response,
                              new ApprovalUnavailable({ reason: "context-unconfirmed" }),
                            ),
                        ),
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
