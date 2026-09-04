import { Deferred, Effect, Fiber, Predicate, Queue } from "effect";
import type * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";

import type {
  Executor,
  InvokeOptions,
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
} from "@executor-js/sdk/core";
import { CodeExecutionError } from "@executor-js/codemode-core";
import type { CodeExecutor, ExecuteResult, SandboxToolInvoker } from "@executor-js/codemode-core";

import {
  defaultToolDiscoveryProvider,
  makeExecutorToolInvoker,
  listExecutorIntegrations,
  describeTool,
  type ToolDiscoveryProvider,
} from "./tool-invoker";
import { ExecutionToolError } from "./errors";
import { buildExecuteDescription } from "./description";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionEngineConfig<E extends Cause.YieldableError = CodeExecutionError> = {
  readonly executor: Executor;
  readonly codeExecutor: CodeExecutor<E>;
  readonly toolDiscoveryProvider?: ToolDiscoveryProvider;
};

export type ExecutionResult =
  | { readonly status: "completed"; readonly result: ExecuteResult }
  | { readonly status: "paused"; readonly execution: PausedExecution };

export type PausedExecution = {
  readonly id: string;
  readonly elicitationContext: ElicitationContext;
};

export type PausedExecutionDeadline = {
  readonly expiresAt: string;
  readonly ttlMs: number;
};

/** Internal representation with Effect runtime state for pause/resume. */
type InternalPausedExecution<E> = PausedExecution & {
  readonly response: Deferred.Deferred<typeof ElicitationResponse.Type>;
  readonly fiber: Fiber.Fiber<ExecuteResult, E>;
  readonly pauseQueue: Queue.Queue<InternalPausedExecution<E>>;
};

export type ResumeResponse = {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Record<string, unknown>;
};

// Auto-accept every elicitation. Used by the `autoApprove` path where the
// caller is itself the human approver (the operator-facing Run/Test panel).
const acceptAllHandler: ElicitationHandler = () => Effect.succeed({ action: "accept" });

/**
 * Approximate size of the value a script returned, before any preview
 * truncation. This is the "did the model narrow in code or dump the raw
 * payload" metric: a compact JSON length, not the pretty-printed preview the
 * model receives, so treat it as magnitude. -1 means unmeasurable (a value
 * `JSON.stringify` rejects, e.g. a BigInt) — unknown size, not zero.
 */
const measureResultChars = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort size probe over an arbitrary sandbox value; a stringify rejection must not fail the execution path
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return -1;
  }
};

/**
 * Outcome attributes are a pure function of an immutable `ExecuteResult`, but
 * the same result object is annotated more than once: the `autoApprove` path
 * stamps both the inner inline span and the outer pausable span, and resume
 * retries replay the settled result cached per execution id. The size probe
 * walks the whole result value (`JSON.stringify`), so its cost grows with the
 * payload — memoize the record per result object so each result is walked
 * once, no matter how many spans it is stamped onto.
 */
const executeOutcomeAttributesCache = new WeakMap<ExecuteResult, Record<string, unknown>>();

const executeOutcomeAttributes = (result: ExecuteResult): Record<string, unknown> => {
  const cached = executeOutcomeAttributesCache.get(result);
  if (cached) return cached;
  const attributes = {
    "mcp.execute.result_chars": measureResultChars(result.result),
    "mcp.execute.log_chars": result.logs?.reduce((total, line) => total + line.length, 0) ?? 0,
    "mcp.execute.emitted": result.output?.length ?? 0,
    ...(result.error
      ? { "mcp.execute.outcome": "fail", "mcp.execute.error_kind": result.errorKind ?? "unknown" }
      : { "mcp.execute.outcome": "ok" }),
  };
  executeOutcomeAttributesCache.set(result, attributes);
  return attributes;
};

/**
 * Stamp the current `mcp.execute` / `mcp.execute.resume` span with how the
 * execution ended and how much data it sent back toward model context.
 * Sandbox failures ride the success channel as `ExecuteResult.error`, so
 * without this the span reads OK and the failure class is unqueryable.
 * Attributes stay enumerable identifiers and sizes — never the error message
 * or result content itself.
 */
const annotateExecuteOutcome = (result: ExecuteResult) =>
  Effect.annotateCurrentSpan(executeOutcomeAttributes(result));

const annotateExecutionOutcome = (execution: ExecutionResult) =>
  execution.status === "paused"
    ? Effect.annotateCurrentSpan({ "mcp.execute.outcome": "paused" })
    : annotateExecuteOutcome(execution.result);

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

const MAX_PREVIEW_CHARS = 30_000;

const truncate = (value: string, max: number): string =>
  value.length > max
    ? `${value.slice(0, max)}\n... [truncated ${value.length - max} chars]`
    : value;

export const formatExecuteResult = (
  result: ExecuteResult,
): {
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
} => {
  const resultText =
    result.result != null
      ? typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result, null, 2)
      : null;

  const logText = result.logs && result.logs.length > 0 ? result.logs.join("\n") : null;

  // `emit()` output is shown to the user, not returned to the model, so a
  // script that only emits comes back with a null result. Acknowledge the
  // emitted items in the envelope so an emit-without-return reads as "output
  // went to the user" rather than a silent void.
  const emitted = result.output?.length ?? 0;
  const emittedNote =
    emitted > 0 ? `${emitted} item${emitted === 1 ? "" : "s"} emitted to the user` : null;
  const emittedField = emitted > 0 ? { emitted } : {};

  if (result.error) {
    const parts = [`Error: ${result.error}`, ...(logText ? [`\nLogs:\n${logText}`] : [])];
    return {
      text: truncate(parts.join("\n"), MAX_PREVIEW_CHARS),
      structured: {
        status: "error",
        error: result.error,
        ...emittedField,
        logs: result.logs ?? [],
      },
      isError: true,
    };
  }

  const resultPart = resultText
    ? truncate(resultText, MAX_PREVIEW_CHARS)
    : emittedNote
      ? `(no return value; ${emittedNote})`
      : "(no result)";
  const parts = [resultPart, ...(logText ? [`\nLogs:\n${logText}`] : [])];
  return {
    text: parts.join("\n"),
    structured: {
      status: "completed",
      result: result.result ?? null,
      ...emittedField,
      logs: result.logs ?? [],
    },
    isError: false,
  };
};

export const formatPausedExecution = (
  paused: PausedExecution,
  options?: { readonly deadline?: PausedExecutionDeadline },
): {
  text: string;
  structured: Record<string, unknown>;
} => {
  const req = paused.elicitationContext.request;
  const lines: string[] = [`Execution paused: ${req.message}`];
  const deadline = options?.deadline;
  const isUrlElicitation = Predicate.isTagged(req, "UrlElicitation");
  const isFormElicitation = Predicate.isTagged(req, "FormElicitation");
  const requestedSchema = isFormElicitation ? req.requestedSchema : undefined;
  const hasRequestedSchema =
    requestedSchema !== undefined && Object.keys(requestedSchema).length > 0;
  const baseInstructions = isUrlElicitation
    ? `The user needs to open this URL in a browser and complete the flow. After the user finishes, call the resume tool with executionId "${paused.id}" and action "accept".`
    : hasRequestedSchema
      ? `Ask the user for values matching requestedSchema. Then call the resume tool with executionId "${paused.id}", action "accept", and content matching requestedSchema. If the user declines, call resume with action "decline" or "cancel".`
      : `This is a model-side confirmation gate; there is no browser form to open. Ask the user whether to approve the paused tool call. If the user approves, call the resume tool with executionId "${paused.id}" and action "accept". If the user declines, call resume with action "decline" or "cancel".`;
  const deadlineInstructions = deadline
    ? ` Resume before ${deadline.expiresAt}; this approval window lasts ${formatTtlDuration(deadline.ttlMs)}.`
    : "";
  const instructions = `${baseInstructions}${deadlineInstructions}`;

  if (isUrlElicitation) {
    lines.push(`\nOpen this URL in a browser:\n${req.url}`);
    lines.push('\nAfter the browser flow, call the resume tool with action "accept".');
  } else if (hasRequestedSchema) {
    lines.push(
      "\nAsk the user for a response matching the requested schema, then call the resume tool.",
    );
    lines.push(`\nRequested schema:\n${JSON.stringify(requestedSchema, null, 2)}`);
  } else {
    lines.push(
      '\nThis is a model-side confirmation gate; no browser form is waiting. Ask the user whether to approve, then call the resume tool with action "accept", "decline", or "cancel".',
    );
  }

  // Terms the upstream attached to the approval. Stated plainly, because a
  // prompt whose schema is empty ("Allow X to access Y?") can still be
  // asking for a PERSISTENT grant, and the answer differs.
  const meta = req.meta;
  if (meta !== undefined && Object.keys(meta).length > 0) {
    lines.push(`\nApproval terms:\n${JSON.stringify(meta, null, 2)}`);
  }

  lines.push(`\nexecutionId: ${paused.id}`);
  if (deadline) {
    lines.push(
      `\nresumeDeadline: ${deadline.expiresAt} (${formatTtlDuration(deadline.ttlMs)} approval window)`,
    );
  }
  lines.push(`\ninstructions: ${instructions}`);

  return {
    text: lines.join("\n"),
    structured: {
      status: "waiting_for_interaction",
      executionId: paused.id,
      ...(deadline ? { expiresAt: deadline.expiresAt, ttlMs: deadline.ttlMs } : {}),
      interaction: {
        kind: isUrlElicitation ? "url" : "form",
        message: req.message,
        instructions,
        address: String(paused.elicitationContext.address),
        args: paused.elicitationContext.args,
        ...(isUrlElicitation ? { url: req.url } : {}),
        ...(isFormElicitation ? { requestedSchema: req.requestedSchema } : {}),
        ...(meta === undefined ? {} : { meta }),
      },
    },
  };
};

export const formatTtlDuration = (ttlMs: number): string => {
  const seconds = Math.max(1, Math.round(ttlMs / 1000));
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
};

// ---------------------------------------------------------------------------
// Full invoker (base + discover + describe)
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readOptionalLimit = (value: unknown, toolName: string): number | ExecutionToolError => {
  if (value === undefined) {
    return 12;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return new ExecutionToolError({
      message: `${toolName} limit must be a positive number when provided`,
    });
  }

  return Math.floor(value);
};

const readOptionalOffset = (value: unknown, toolName: string): number | ExecutionToolError => {
  if (value === undefined) {
    return 0;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return new ExecutionToolError({
      message: `${toolName} offset must be a non-negative number when provided`,
    });
  }

  return Math.floor(value);
};

const makeFullInvoker = (
  executor: Executor,
  invokeOptions: InvokeOptions,
  toolDiscoveryProvider: ToolDiscoveryProvider,
): SandboxToolInvoker => {
  const base = makeExecutorToolInvoker(executor, { invokeOptions });
  return {
    invoke: ({ path, args }) => {
      if (path === "search") {
        if (!isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message:
                "tools.search expects an object: { query?: string; namespace?: string; limit?: number; offset?: number }",
            }),
          );
        }

        if (args.query !== undefined && typeof args.query !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.search query must be a string when provided",
            }),
          );
        }

        if (args.namespace !== undefined && typeof args.namespace !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.search namespace must be a string when provided",
            }),
          );
        }

        const limit = readOptionalLimit(args.limit, "tools.search");
        if (Predicate.isTagged(limit, "ExecutionToolError")) {
          return Effect.fail(limit);
        }

        const offset = readOptionalOffset(args.offset, "tools.search");
        if (Predicate.isTagged(offset, "ExecutionToolError")) {
          return Effect.fail(offset);
        }

        return toolDiscoveryProvider
          .searchTools({
            executor,
            query: args.query ?? "",
            limit,
            namespace: args.namespace,
            offset,
          })
          .pipe(
            Effect.withSpan("mcp.tool.dispatch", {
              attributes: { "mcp.tool.name": path, "executor.tool.builtin": true },
            }),
          );
      }
      if (path === "executor.integrations.list") {
        if (args !== undefined && !isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message:
                "tools.executor.integrations.list expects an object: { query?: string; limit?: number; offset?: number }",
            }),
          );
        }

        if (isRecord(args) && args.query !== undefined && typeof args.query !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.executor.integrations.list query must be a string when provided",
            }),
          );
        }

        const limit = readOptionalLimit(
          isRecord(args) ? args.limit : undefined,
          "tools.executor.integrations.list",
        );
        if (Predicate.isTagged(limit, "ExecutionToolError")) {
          return Effect.fail(limit);
        }

        const offset = readOptionalOffset(
          isRecord(args) ? args.offset : undefined,
          "tools.executor.integrations.list",
        );
        if (Predicate.isTagged(offset, "ExecutionToolError")) {
          return Effect.fail(offset);
        }

        return listExecutorIntegrations(executor, {
          query: isRecord(args) && typeof args.query === "string" ? args.query : undefined,
          limit,
          offset,
        }).pipe(
          Effect.withSpan("mcp.tool.dispatch", {
            attributes: { "mcp.tool.name": path, "executor.tool.builtin": true },
          }),
        );
      }
      if (path === "describe.tool") {
        if (!isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.describe.tool expects an object: { path: string }",
            }),
          );
        }

        if (typeof args.path !== "string" || args.path.trim().length === 0) {
          return Effect.fail(new ExecutionToolError({ message: "describe.tool requires a path" }));
        }

        if ("includeSchemas" in args) {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.describe.tool no longer accepts includeSchemas",
            }),
          );
        }

        return describeTool(executor, args.path).pipe(
          Effect.withSpan("mcp.tool.dispatch", {
            attributes: {
              "mcp.tool.name": path,
              "executor.tool.builtin": true,
              "executor.tool.target_path": args.path,
            },
          }),
        );
      }
      return base.invoke({ path, args });
    },
  };
};

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

export type ExecutionEngine<E extends Cause.YieldableError = CodeExecutionError> = {
  /**
   * Execute code with elicitation handled inline by the provided handler.
   * Use this when the host supports elicitation (e.g. MCP with elicitation capability).
   *
   * Fails with the code executor's typed error `E` (defaults to
   * `CodeExecutionError`). Runtimes surface their own `Data.TaggedError`
   * subclass, which flows through here unchanged.
   */
  readonly execute: (
    code: string,
    options: { readonly onElicitation: ElicitationHandler },
  ) => Effect.Effect<ExecuteResult, E>;

  /**
   * Execute code, intercepting the first elicitation as a pause point.
   * Use this when the host doesn't support inline elicitation.
   * Returns either a completed result or a paused execution that can be resumed.
   *
   * `options.autoApprove` treats the caller as the human in the loop: every
   * elicitation is accepted inline, so an approval-gated tool runs to
   * completion instead of pausing. The operator-facing Run/Test panel sets
   * this because clicking Run IS the approval. `block` policies still fail
   * before any elicitation, so this never bypasses a hard block.
   */
  readonly executeWithPause: (
    code: string,
    options?: { readonly autoApprove?: boolean; readonly executionId?: string },
  ) => Effect.Effect<ExecutionResult, E>;

  /**
   * Resume a paused execution. Returns a completed result, a new pause, or
   * null if the executionId was not found.
   */
  readonly resume: (
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<ExecutionResult | null, E>;

  /**
   * True when the engine remembers that an executionId has already settled, even
   * if the replayed outcome has rolled out of the bounded resume cache.
   */
  readonly isExecutionSettled?: (executionId: string) => Effect.Effect<boolean>;

  /**
   * Inspect a paused execution without resuming it. Returns null if the id is
   * unknown or has already been resumed.
   */
  readonly getPausedExecution: (executionId: string) => Effect.Effect<PausedExecution | null>;

  /** Count of executions currently paused awaiting resume. */
  readonly pausedExecutionCount: () => Effect.Effect<number>;

  /** Whether any executions are paused awaiting resume. */
  readonly hasPausedExecutions: () => Effect.Effect<boolean>;

  /**
   * Get the dynamic tool description (workflow + namespaces).
   */
  readonly getDescription: Effect.Effect<string>;

  /**
   * End this engine's in-flight sandbox fibers and wait for them to unwind.
   *
   * `executeWithPause` forks the sandbox as a daemon so a pause can outlive the
   * caller that observed it. That fiber holds the executor, and so the DB handle
   * belonging to whichever scope built this engine. A host that builds an engine
   * per request MUST call this before that scope's connection is closed, or the
   * fiber outlives the pool it queries.
   *
   * Required, not optional: a decorator that wrapped the engine and quietly
   * dropped this member would silently reopen that race, so the type makes
   * forwarding it a compile error.
   */
  readonly shutdown: Effect.Effect<void>;
};

export const createExecutionEngine = <E extends Cause.YieldableError = CodeExecutionError>(
  config: ExecutionEngineConfig<E>,
): ExecutionEngine<E> => {
  const { executor, codeExecutor, toolDiscoveryProvider = defaultToolDiscoveryProvider } = config;
  const pausedExecutions = new Map<string, InternalPausedExecution<E>>();
  // Every sandbox fiber `startPausableExecution` still has in flight.
  //
  // Those fibers are daemons (`Effect.forkDetach`) so a pause can outlive the
  // caller that observed it. But they close over `executor`, and the executor
  // closes over the FumaDB handle the host opened for whatever scope built THIS
  // engine — `makeFumaClient` captures `db` at construction, not per operation.
  // A host that builds one engine per HTTP request therefore needs a way to end
  // that fiber's life with the request; otherwise it wakes up after the
  // request's postgres pool has been closed and every query it makes lands on a
  // dead pool. `shutdown` below is that seam.
  const liveSandboxFibers = new Set<Fiber.Fiber<ExecuteResult, E>>();
  // Outcomes of executions that already settled (resumed to completion, hit a
  // new pause, or died while paused). MCP clients retry `resume` when a
  // response gets lost in transit; without this cache the retry of an
  // already-delivered resume answers "no paused execution" (observed in
  // production seconds after a successful resume). Bounded FIFO — pause
  // volume is tiny (human approvals), so a small window is plenty.
  const settledOutcomes = new Map<string, Exit.Exit<ExecutionResult, E>>();
  const SETTLED_OUTCOME_LIMIT = 64;
  const settledExecutionIds = new Set<string>();
  const SETTLED_EXECUTION_ID_LIMIT = 1024;
  // Resumes whose outcome is still being computed, so a concurrent duplicate
  // awaits the same result instead of missing the (already-consumed) pause.
  const pendingResumes = new Map<string, Deferred.Deferred<ExecutionResult, E>>();

  // Exits (not just successes) so a replayed failure re-fails through the
  // typed channel — hosts render engine failures opaquely, and a replay must
  // not bypass that by flattening the cause into result text.
  const recordSettledOutcome = (executionId: string, exit: Exit.Exit<ExecutionResult, E>): void => {
    settledExecutionIds.add(executionId);
    while (settledExecutionIds.size > SETTLED_EXECUTION_ID_LIMIT) {
      const oldest = settledExecutionIds.keys().next().value;
      if (oldest === undefined) break;
      settledExecutionIds.delete(oldest);
    }
    settledOutcomes.set(executionId, exit);
    while (settledOutcomes.size > SETTLED_OUTCOME_LIMIT) {
      const oldest = settledOutcomes.keys().next().value;
      if (oldest === undefined) break;
      settledOutcomes.delete(oldest);
    }
  };

  /**
   * Race a running fiber against the pause queue. Returns when either
   * the fiber completes or an elicitation handler fires (whichever
   * comes first). Re-used by both executeWithPause and resume.
   *
   * `Effect.raceFirst` (not `Effect.race`) — `race` has prefer-success
   * semantics in Effect v4 ("first successful result"), which means a
   * fiber failure waits indefinitely for the pause Deferred to succeed.
   * For a fast `codeExecutor.execute` failure (e.g. a syntax error
   * inside the dynamic worker) the pause signal never fires, so the
   * outer Effect hangs until the upstream client gives up. `raceFirst`
   * settles on whichever side completes first, success or failure.
   */
  const awaitCompletionOrPause = (
    fiber: Fiber.Fiber<ExecuteResult, E>,
    pauseQueue: Queue.Queue<InternalPausedExecution<E>>,
  ): Effect.Effect<ExecutionResult, E> =>
    Effect.raceFirst(
      Fiber.join(fiber).pipe(
        Effect.map((result): ExecutionResult => ({ status: "completed", result })),
      ),
      Queue.take(pauseQueue).pipe(
        Effect.map((paused): ExecutionResult => {
          pausedExecutions.set(paused.id, paused);
          return { status: "paused", execution: paused };
        }),
      ),
    );

  /**
   * Start an execution in pause/resume mode.
   *
   * The sandbox is forked as a daemon because paused executions can outlive the
   * caller scope that returned the first pause, such as an HTTP request handler.
   */
  const startPausableExecution = Effect.fn("mcp.execute")(function* (
    code: string,
    options?: { readonly autoApprove?: boolean; readonly executionId?: string },
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.mode": "pausable",
      "mcp.execute.code_length": code.length,
    });

    // Operator-approved invoke: run through the inline path with an accept-all
    // handler so an approval gate resolves itself instead of pausing. Never
    // pauses, so the caller always gets a completed result.
    if (options?.autoApprove) {
      yield* Effect.annotateCurrentSpan({ "mcp.execute.auto_approve": true });
      const result = yield* runInlineExecution(code, { onElicitation: acceptAllHandler });
      yield* annotateExecuteOutcome(result);
      return { status: "completed", result } satisfies ExecutionResult;
    }

    // Queue preserves pauses that arrive before the previous approval has
    // returned to the caller, which can happen with concurrent tool calls.
    const pauseQueue = yield* Queue.unbounded<InternalPausedExecution<E>>();

    // Will be set once the fiber is forked.
    let fiber: Fiber.Fiber<ExecuteResult, E>;

    const elicitationHandler: ElicitationHandler = (ctx) =>
      Effect.gen(function* () {
        const responseDeferred = yield* Deferred.make<typeof ElicitationResponse.Type>();
        // Globally unique — engine instances are rebuilt on host restarts
        // (Durable Object cold restores, redeploys), so a counter would
        // re-mint the same ids and let a stale client resume bind to a
        // different execution's pause.
        const id = options?.executionId ?? `exec_${crypto.randomUUID()}`;

        const paused: InternalPausedExecution<E> = {
          id,
          elicitationContext: ctx,
          response: responseDeferred,
          fiber: fiber!,
          pauseQueue,
        };
        yield* Queue.offer(pauseQueue, paused);

        // Suspend until resume() completes responseDeferred.
        return yield* Deferred.await(responseDeferred);
      });

    const invoker = makeFullInvoker(
      executor,
      { onElicitation: elicitationHandler },
      toolDiscoveryProvider,
    );
    fiber = yield* Effect.forkDetach(
      codeExecutor.execute(code, invoker).pipe(Effect.withSpan("executor.code.exec")),
    );
    liveSandboxFibers.add(fiber);

    // When the fiber settles on its own (sandbox timeout, failure) while
    // pauses are still outstanding, drop them: getPausedExecution must not
    // report a pause whose fiber can no longer consume a response, and the
    // map must not grow forever. A resume retry still finds the terminal
    // outcome via the settled-outcome cache.
    const sandboxFiber = fiber;
    yield* Effect.forkDetach(
      Fiber.await(sandboxFiber).pipe(
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            // Settled on its own — it can no longer touch the host's DB handle,
            // so it is not `shutdown`'s problem any more.
            liveSandboxFibers.delete(sandboxFiber);
            const outcome = Exit.map(
              exit,
              (result): ExecutionResult => ({ status: "completed", result }),
            );
            for (const [id, paused] of pausedExecutions) {
              if (paused.fiber !== sandboxFiber) continue;
              pausedExecutions.delete(id);
              recordSettledOutcome(id, outcome);
            }
          }),
        ),
      ),
    );

    const outcome = (yield* awaitCompletionOrPause(fiber, pauseQueue)) as ExecutionResult;
    yield* annotateExecutionOutcome(outcome);
    return outcome;
  });

  /**
   * Resume a paused execution. Completes the response Deferred to unblock the
   * fiber, then races completion against the next queued or future pause.
   *
   * Idempotent per executionId: MCP clients retry `resume` when a response is
   * lost in transit, so a duplicate of an already-delivered resume replays the
   * recorded outcome, and a duplicate that arrives while the first is still
   * in flight awaits the same outcome instead of reporting a missing pause.
   */
  const resumeExecution = Effect.fn("mcp.execute.resume")(function* (
    executionId: string,
    response: ResumeResponse,
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.resume.action": response.action,
    });

    const settled = settledOutcomes.get(executionId);
    if (settled) {
      yield* Effect.annotateCurrentSpan({ "mcp.execute.resume.replayed": true });
      const replayed = (yield* settled) as ExecutionResult;
      yield* annotateExecutionOutcome(replayed);
      return replayed;
    }

    const pending = pendingResumes.get(executionId);
    if (pending) {
      yield* Effect.annotateCurrentSpan({ "mcp.execute.resume.joined_inflight": true });
      const joined = (yield* Deferred.await(pending)) as ExecutionResult;
      yield* annotateExecutionOutcome(joined);
      return joined;
    }

    const paused = pausedExecutions.get(executionId);
    if (!paused) return null;
    pausedExecutions.delete(executionId);

    const inflight = yield* Deferred.make<ExecutionResult, E>();
    pendingResumes.set(executionId, inflight);

    yield* Deferred.succeed(paused.response, {
      action: response.action as typeof ElicitationResponse.Type.action,
      content: response.content,
    });

    const outcome = (yield* awaitCompletionOrPause(paused.fiber, paused.pauseQueue).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          // A caller-supplied id remains the identity of the whole execution,
          // including later pauses. Do not cache an intermediate pause under
          // that same id or the next resume would replay it forever. HTTP
          // resume idempotency is persisted separately per pause sequence.
          if (
            !(
              Exit.isSuccess(exit) &&
              exit.value.status === "paused" &&
              exit.value.execution.id === executionId
            )
          ) {
            recordSettledOutcome(executionId, exit);
          }
          pendingResumes.delete(executionId);
          yield* Deferred.done(inflight, exit);
        }),
      ),
    )) as ExecutionResult;
    yield* annotateExecutionOutcome(outcome);
    return outcome;
  });

  /**
   * Inline-elicitation execute path. Wrapped so every call produces an
   * `mcp.execute` span with the inner `executor.code.exec` as a child.
   */
  const runInlineExecution = Effect.fn("mcp.execute")(function* (
    code: string,
    options: { readonly onElicitation: ElicitationHandler },
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.mode": "inline",
      "mcp.execute.code_length": code.length,
    });
    const invoker = makeFullInvoker(
      executor,
      {
        onElicitation: options.onElicitation,
      },
      toolDiscoveryProvider,
    );
    const result = yield* codeExecutor
      .execute(code, invoker)
      .pipe(Effect.withSpan("executor.code.exec"));
    yield* annotateExecuteOutcome(result);
    return result;
  });

  /**
   * End this engine's sandbox fibers, and WAIT for them to finish unwinding.
   *
   * A host calls this when the scope that owns the engine's DB handle is about
   * to close. Interruption is awaited rather than fired and forgotten: the point
   * is that no sandbox fiber is still able to issue a query by the time the
   * host's connection finalizer runs, so returning early would reopen the very
   * race this closes.
   *
   * Paused executions are dropped with the fibers — a pause whose fiber has been
   * interrupted can never consume a response, so leaving the entry behind would
   * only let a later `resume` hand back a pause that cannot progress.
   */
  const shutdown: Effect.Effect<void> = Effect.suspend(() => {
    const fibers = Array.from(liveSandboxFibers);
    liveSandboxFibers.clear();
    for (const [id, paused] of pausedExecutions) {
      if (fibers.includes(paused.fiber)) pausedExecutions.delete(id);
    }
    return Fiber.interruptAll(fibers);
  });

  return {
    execute: runInlineExecution,
    executeWithPause: startPausableExecution,
    resume: resumeExecution,
    shutdown,
    isExecutionSettled: (executionId) => Effect.sync(() => settledExecutionIds.has(executionId)),
    getPausedExecution: (executionId) =>
      Effect.sync(() => pausedExecutions.get(executionId) ?? null),
    pausedExecutionCount: () => Effect.sync(() => pausedExecutions.size),
    hasPausedExecutions: () => Effect.sync(() => pausedExecutions.size > 0),
    getDescription: buildExecuteDescription(executor),
  };
};
