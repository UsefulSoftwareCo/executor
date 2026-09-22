import type { ExecutionRejected } from "../contracts/execute.ts";
/** Execution-owned tool invocations and pending interactions. Delivery never owns the continuation. */
import type { CodeMode } from "@opencode-ai/codemode";
import {
  ElicitationFailed,
  ToolInputs,
  type ToolCallResult,
  type ToolPending,
} from "@executor-js/sdk/core";
import {
  defaultElicitationLimits,
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
  Queue,
  Schema,
  Scope,
  Scheduler,
} from "effect";
import type { McpBackend } from "../contracts/backend.ts";
import {
  defaultMcpRuntimeLimits,
  ElicitationRequestId,
  ElicitationResponseInvalid,
  ResumeInput,
  type InteractionId,
  type ToolInputPending,
  type ExecuteResult,
  type McpExecutionResult,
  type McpLimits,
} from "../contracts/execute.ts";
import type { BrowserApprovalView, BrowserApprovalAcknowledgement } from "../contracts/browser.ts";
import { programScheduler } from "./program-scheduler.ts";
import { executeProgram } from "./execute.ts";

class ApprovalTooLarge extends Schema.TaggedError<ApprovalTooLarge>()("ApprovalTooLarge", {}) {}
class ApprovalDenied extends Schema.TaggedError<ApprovalDenied>()("ApprovalDenied", {}) {}
class ApprovalCancelled extends Schema.TaggedError<ApprovalCancelled>()("ApprovalCancelled", {}) {}
class McpExecutionFailed extends Schema.TaggedError<McpExecutionFailed>()(
  "McpExecutionFailed",
  {},
) {}
class ApprovalUnavailable extends Schema.TaggedError<ApprovalUnavailable>()(
  "ApprovalUnavailable",
  {},
) {}

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
  readonly scheduling: ReturnType<typeof programScheduler>;
  readonly caller: string;
  readonly scope: Scope.Closeable;
  readonly events: Queue.Queue<Event>;
  readonly pending: Map<InteractionId, Pending>;
  readonly operations: Set<Operation>;
  readonly calls: Array<CodeMode.ToolCall>;
  remainingMs: number;
  busy: boolean;
  closed: boolean;
};

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
    const requests = new Map<InteractionId, Pending>();
    const unavailable = (requestId: InteractionId): McpExecutionResult => ({
      status: "unavailable",
      requestId,
    });
    const failure = (
      run: Run,
      kind: CodeMode.DiagnosticKind,
      message: string,
    ): McpExecutionResult & { status: "completed" } => ({
      status: "completed",
      execution: { ok: false, error: { kind, message }, toolCalls: [...run.calls] },
      unavailableApps: [],
    });
    const wake = (run: Run) => Queue.offer(run.events, { kind: "wake" });
    const forget = (pending: Pending) => {
      requests.delete(pending.request.requestId);
      pending.run.pending.delete(pending.request.requestId);
      // Wake collectors atomically with removal; an already recorded answer is never overwritten.
      Deferred.doneUnsafe(pending.browserAnswer, Effect.succeed(undefined));
    };
    const stop = (run: Run) =>
      Effect.suspend(() => {
        if (run.closed) return Effect.void;
        run.closed = true;
        run.scheduling.resume();
        for (const pending of run.pending.values()) forget(pending);
        runs.delete(run);
        return Scope.close(run.scope, Exit.void);
      });
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...runs], stop, { concurrency: "unbounded", discard: true }),
    );
    yield* Effect.forkIn(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("1 second");
          const now = yield* Clock.currentTimeMillis;
          for (const run of runs) {
            if ([...run.pending.values()].some(({ request }) => request.expiresAt <= now))
              yield* stop(run);
          }
        }
      }),
      hostScope,
    ).pipe(Effect.provideContext(baseContext));

    const record = (pending: Pending) =>
      Effect.gen(function* () {
        if (pending.run.closed) return yield* new ApprovalUnavailable();
        if (
          new TextEncoder().encode(JSON.stringify(pending.request)).byteLength >
          limits.maxOutputBytes
        )
          return yield* new ApprovalTooLarge();
        pending.run.pending.set(pending.request.requestId, pending);
        requests.set(pending.request.requestId, pending);
        yield* wake(pending.run);
      });

    const elicitation =
      (
        run: Run,
        operation: Operation,
        tool: (typeof ToolInputPending.Type)["tool"],
      ): ElicitationHandler =>
      (input, signal) =>
        Effect.gen(function* () {
          const form = yield* prepareElicitation(input);
          if (signal.aborted || run.closed)
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
            Effect.mapError(() => new ElicitationFailed({ reason: "invalid-request" })),
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
                forget(pending);
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

    const broker = (run: Run): McpBackend<Error> => {
      const exchange = <A>(
        work: (backend: McpBackend<Error>, operation: Operation) => Effect.Effect<A, Error>,
        deliver: (value: A, response: Deferred.Deferred<A, Error>) => Effect.Effect<void, Error> = (
          value,
          response,
        ) => Deferred.succeed(response, value).pipe(Effect.asVoid),
      ) =>
        Effect.gen(function* () {
          const response = yield* Deferred.make<A, Error>();
          const cancelled = yield* Deferred.make<void>();
          const handle: Work = (backend, operation) =>
            work(backend, operation).pipe(
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
        listSkills: (input) => exchange((backend) => backend.listSkills(input)),
        readSkill: (input) => exchange((backend) => backend.readSkill(input)),
        listApps: (input) => exchange((backend) => backend.listApps(input)),
        listTargets: (input) => exchange((backend) => backend.listTargets(input)),
        listTools: (input) => exchange((backend) => backend.listTools(input)),
        callTool: (input) =>
          exchange(
            (backend, operation) =>
              backend
                .callTool(input, {
                  elicitation: elicitation(run, operation, {
                    app: input.app,
                    tool: input.tool,
                    profile: input.profile,
                    expectedProfileRevision: input.expectedProfileRevision,
                  }),
                })
                .pipe(
                  Effect.withSpan("mcp.tool.call", {
                    attributes: { "executor.app.id": input.app, "executor.tool.name": input.tool },
                  }),
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
                respond: (input) =>
                  Schema.decodeUnknownEffect(ToolInputs.resume.fields.response)(input).pipe(
                    Effect.mapError(() => new ElicitationResponseInvalid()),
                  ),
              });
            },
          ),
        authorizeElicitation: () => Effect.fail(new ElicitationFailed({ reason: "unavailable" })),
        resumeInvocation: () => Effect.fail(new ApprovalUnavailable()),
      };
    };

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
            if (run.closed)
              return failure(
                run,
                "ExecutionFailure",
                "Execution ended; its continuation is unavailable",
              );
            const completed = yield* Match.value(event).pipe(
              Match.when({ kind: "operation" }, ({ handle }) =>
                launch(run, backend, handle).pipe(Effect.as(undefined)),
              ),
              Match.when({ kind: "done" }, ({ result }) =>
                stop(run).pipe(Effect.as({ status: "completed" as const, ...result })),
              ),
              Match.when({ kind: "wake" }, () => Effect.succeed(undefined)),
              Match.exhaustive,
            );
            if (completed !== undefined) return completed;
            // Calls awaiting input remain owned by run.scope. Other admitted work must finish before parking.
            if (
              run.pending.size > 0 &&
              [...run.operations].every((operation) => operation.waiting.size > 0)
            ) {
              yield* Effect.yieldNow;
              if ((yield* Queue.size(run.events)) === 0) {
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
              Effect.andThen(stop(run)),
              Effect.map(() =>
                failure(
                  run,
                  "TimeoutExceeded",
                  "Execution timed out; earlier tool calls may have completed",
                ),
              ),
            ),
          ),
          Effect.onInterrupt(() => stop(run)),
          Effect.ensuring(
            Effect.gen(function* () {
              run.remainingMs -= Math.max(0, (yield* Clock.currentTimeMillis) - started);
              run.busy = false;
            }),
          ),
        );
      });

    const current = (caller: string, id: InteractionId) =>
      Effect.gen(function* () {
        const pending = requests.get(id);
        if (pending === undefined || pending.run.caller !== caller) return undefined;
        if (pending.request.expiresAt <= (yield* Clock.currentTimeMillis)) {
          yield* stop(pending.run);
          return undefined;
        }
        return pending;
      });
    return {
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
      /** Discard all interactions and live work for the caller's program. */
      discard: (caller: string, requestId: InteractionId): Effect.Effect<void> =>
        Effect.suspend(() => {
          const pending = requests.get(requestId);
          return pending !== undefined && pending.run.caller === caller
            ? stop(pending.run)
            : Effect.void;
        }),
      /** Start one program. Policy consent and tool input return the same pending-interaction union. */
      execute: (
        caller: string,
        backend: McpBackend<Error>,
        code: string,
      ): Effect.Effect<McpExecutionResult, ExecutionRejected> =>
        Effect.gen(function* () {
          if (runs.size >= defaultMcpRuntimeLimits.maxExecutions)
            return { status: "capacity-exceeded" };
          const run: Run = {
            caller,
            scheduling: programScheduler(scheduler),
            scope: yield* Scope.make(),
            events: yield* Queue.unbounded<Event>(),
            pending: new Map(),
            operations: new Set(),
            calls: [],
            remainingMs: limits.timeoutMs,
            busy: false,
            closed: false,
          };
          if (runs.size >= defaultMcpRuntimeLimits.maxExecutions) {
            yield* Scope.close(run.scope, Exit.void);
            return { status: "capacity-exceeded" };
          }
          runs.add(run);
          yield* beforeExecute.pipe(
            Effect.onError(() => stop(run)),
            Effect.onInterrupt(() => stop(run)),
          );
          const program = executeProgram(
            broker(run),
            { maxToolCalls: limits.maxToolCalls, maxOutputBytes: limits.maxOutputBytes },
            code,
            (call) => run.calls.push(call),
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
            return unavailable(input.requestId);
          const response = yield* pending.respond(input.response);
          const run = pending.run;
          if (pending.request.expiresAt <= (yield* Clock.currentTimeMillis)) {
            yield* stop(run);
            return unavailable(input.requestId);
          }
          if (requests.get(input.requestId) !== pending) return unavailable(input.requestId);
          if (run.busy) return { status: "busy", requestId: input.requestId };
          run.busy = true;
          forget(pending);
          const begin = Match.value(pending).pipe(
            Match.when({ kind: "approval" }, (pending) =>
              launch(run, backend, (active, operation) =>
                active
                  .resumeInvocation(pending.request, response, {
                    elicitation: elicitation(run, operation, {
                      app: pending.request.invocation.app,
                      tool: pending.request.invocation.tool,
                      profile: pending.request.invocation.profile,
                      expectedProfileRevision: pending.request.invocation.profileRevision,
                    }),
                  })
                  .pipe(
                    Effect.withSpan("mcp.tool.resume", {
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
                        Match.whenOr({ status: "failed" }, { status: "already-consumed" }, () =>
                          Deferred.fail(pending.response, new ApprovalUnavailable()),
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
