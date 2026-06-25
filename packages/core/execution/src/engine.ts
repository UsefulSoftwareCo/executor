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
  addressToPath,
  defaultToolDiscoveryProvider,
  makeExecutorToolInvoker,
  listExecutorSources,
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

/** One directly-callable tool, as enumerated for non-code-mode MCP. The
 *  `name` is the sandbox-callable path (`<integration>.<owner>.<connection>.<tool>`
 *  or a static fqid), which doubles as the wire tool name clients call back
 *  with. `inputSchema` is self-contained JSON Schema (shared `$defs` already
 *  inlined by `tools.list({ includeSchemas: true })`). */
export type ToolListing = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
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
): {
  text: string;
  structured: Record<string, unknown>;
} => {
  const req = paused.elicitationContext.request;
  const lines: string[] = [`Execution paused: ${req.message}`];
  const isUrlElicitation = Predicate.isTagged(req, "UrlElicitation");
  const isFormElicitation = Predicate.isTagged(req, "FormElicitation");
  const requestedSchema = isFormElicitation ? req.requestedSchema : undefined;
  const hasRequestedSchema =
    requestedSchema !== undefined && Object.keys(requestedSchema).length > 0;
  const instructions = isUrlElicitation
    ? `The user needs to open this URL in a browser and complete the flow. After the user finishes, call the resume tool with executionId "${paused.id}" and action "accept".`
    : hasRequestedSchema
      ? `Ask the user for values matching requestedSchema. Then call the resume tool with executionId "${paused.id}", action "accept", and content matching requestedSchema. If the user declines, call resume with action "decline" or "cancel".`
      : `This is a model-side confirmation gate; there is no browser form to open. Ask the user whether to approve the paused tool call. If the user approves, call the resume tool with executionId "${paused.id}" and action "accept". If the user declines, call resume with action "decline" or "cancel".`;

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

  lines.push(`\nexecutionId: ${paused.id}`);
  lines.push(`\ninstructions: ${instructions}`);

  return {
    text: lines.join("\n"),
    structured: {
      status: "waiting_for_interaction",
      executionId: paused.id,
      interaction: {
        kind: isUrlElicitation ? "url" : "form",
        message: req.message,
        instructions,
        address: String(paused.elicitationContext.address),
        args: paused.elicitationContext.args,
        ...(isUrlElicitation ? { url: req.url } : {}),
        ...(isFormElicitation ? { requestedSchema: req.requestedSchema } : {}),
      },
    },
  };
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

/** Pull a human-readable message off an engine-level invoke failure (always an
 *  `ExecutionToolError` once the base invoker has mapped expected failures into
 *  the success channel), falling back to a string render. */
// oxlint-disable executor/no-unknown-error-message -- boundary: SandboxToolInvoker.invoke declares an `unknown` error channel (kernel contract); the tag guard narrows it to ExecutionToolError before rendering, with a String() fallback for the impossible-defect case
const toolErrorMessage = (error: unknown): string =>
  Predicate.isTagged(error, "ExecutionToolError") &&
  "message" in error &&
  typeof error.message === "string"
    ? error.message
    : String(error);
// oxlint-enable executor/no-unknown-error-message

/**
 * Invoke a single tool through the base invoker and normalize the outcome into
 * an `ExecuteResult`. The base invoker already routes expected tool failures
 * (HTTP errors, auth walls, not-found, bad args) into the success channel as a
 * `ToolResult` envelope; only engine-level failures (user-declined approval,
 * opaque defects) reach the error channel, and those become `result.error`.
 * Shared by the native and pause-mode non-code-mode paths so both render the
 * same way.
 */
const invokeToolAsExecuteResult = (
  invoker: SandboxToolInvoker,
  name: string,
  args: unknown,
): Effect.Effect<ExecuteResult, never> =>
  invoker.invoke({ path: name, args }).pipe(
    Effect.map((result): ExecuteResult => ({ result })),
    Effect.catch((error: unknown) =>
      Effect.succeed<ExecuteResult>({ result: undefined, error: toolErrorMessage(error) }),
    ),
  );

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
      if (path === "executor.sources.list") {
        if (args !== undefined && !isRecord(args)) {
          return Effect.fail(
            new ExecutionToolError({
              message:
                "tools.executor.sources.list expects an object: { query?: string; limit?: number; offset?: number }",
            }),
          );
        }

        if (isRecord(args) && args.query !== undefined && typeof args.query !== "string") {
          return Effect.fail(
            new ExecutionToolError({
              message: "tools.executor.sources.list query must be a string when provided",
            }),
          );
        }

        const limit = readOptionalLimit(
          isRecord(args) ? args.limit : undefined,
          "tools.executor.sources.list",
        );
        if (Predicate.isTagged(limit, "ExecutionToolError")) {
          return Effect.fail(limit);
        }

        const offset = readOptionalOffset(
          isRecord(args) ? args.offset : undefined,
          "tools.executor.sources.list",
        );
        if (Predicate.isTagged(offset, "ExecutionToolError")) {
          return Effect.fail(offset);
        }

        return listExecutorSources(executor, {
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
   */
  readonly executeWithPause: (code: string) => Effect.Effect<ExecutionResult, E>;

  /**
   * Resume a paused execution. Returns a completed result, a new pause, or
   * null if the executionId was not found.
   */
  readonly resume: (
    executionId: string,
    response: ResumeResponse,
  ) => Effect.Effect<ExecutionResult | null, E>;

  /**
   * Inspect a paused execution without resuming it. Returns null if the id is
   * unknown or has already been resumed.
   */
  readonly getPausedExecution: (executionId: string) => Effect.Effect<PausedExecution | null>;

  /**
   * Get the dynamic tool description (workflow + namespaces).
   */
  readonly getDescription: Effect.Effect<string>;

  /**
   * Enumerate every directly-callable tool with a self-contained input schema.
   * Backs the non-code-mode MCP surface that exposes each tool individually
   * instead of behind the single `execute` tool.
   */
  readonly listTools: Effect.Effect<readonly ToolListing[]>;

  /**
   * Invoke a single tool by its wire name with elicitation handled inline by
   * the provided handler. The non-code-mode counterpart to {@link execute}.
   */
  readonly invokeTool: (
    name: string,
    args: unknown,
    options: { readonly onElicitation: ElicitationHandler },
  ) => Effect.Effect<ExecuteResult, E>;

  /**
   * Invoke a single tool by its wire name, intercepting an approval gate as a
   * pause point. The non-code-mode counterpart to {@link executeWithPause}.
   */
  readonly invokeToolWithPause: (name: string, args: unknown) => Effect.Effect<ExecutionResult, E>;
};

export const createExecutionEngine = <E extends Cause.YieldableError = CodeExecutionError>(
  config: ExecutionEngineConfig<E>,
): ExecutionEngine<E> => {
  const { executor, codeExecutor, toolDiscoveryProvider = defaultToolDiscoveryProvider } = config;
  const pausedExecutions = new Map<string, InternalPausedExecution<E>>();
  // Outcomes of executions that already settled (resumed to completion, hit a
  // new pause, or died while paused). MCP clients retry `resume` when a
  // response gets lost in transit; without this cache the retry of an
  // already-delivered resume answers "no paused execution" (observed in
  // production seconds after a successful resume). Bounded FIFO — pause
  // volume is tiny (human approvals), so a small window is plenty.
  const settledOutcomes = new Map<string, Exit.Exit<ExecutionResult, E>>();
  const SETTLED_OUTCOME_LIMIT = 64;
  // Resumes whose outcome is still being computed, so a concurrent duplicate
  // awaits the same result instead of missing the (already-consumed) pause.
  const pendingResumes = new Map<string, Deferred.Deferred<ExecutionResult, E>>();

  // Exits (not just successes) so a replayed failure re-fails through the
  // typed channel — hosts render engine failures opaquely, and a replay must
  // not bypass that by flattening the cause into result text.
  const recordSettledOutcome = (executionId: string, exit: Exit.Exit<ExecutionResult, E>): void => {
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
        Effect.map((paused): ExecutionResult => ({ status: "paused", execution: paused })),
      ),
    );

  /**
   * Run a sandbox workload in pause/resume mode, generic over what the
   * workload is: code-mode `codeExecutor.execute`, or a single non-code-mode
   * tool invoke. The caller builds its own invoker from the supplied
   * `onElicitation` handler (the full discover/describe invoker for code mode,
   * the bare invoker for a single tool) so the pause/queue/cleanup machinery
   * stays shared and identical.
   *
   * The workload is forked as a daemon because paused executions can outlive
   * the caller scope that returned the first pause, such as an HTTP request
   * handler.
   */
  const runWithPause = (
    run: (onElicitation: ElicitationHandler) => Effect.Effect<ExecuteResult, E>,
    attributes: Record<string, string | number | boolean>,
  ): Effect.Effect<ExecutionResult, E> =>
    Effect.gen(function* () {
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
          const id = `exec_${crypto.randomUUID()}`;

          const paused: InternalPausedExecution<E> = {
            id,
            elicitationContext: ctx,
            response: responseDeferred,
            fiber: fiber!,
            pauseQueue,
          };
          pausedExecutions.set(id, paused);

          yield* Queue.offer(pauseQueue, paused);

          // Suspend until resume() completes responseDeferred.
          return yield* Deferred.await(responseDeferred);
        });

      fiber = yield* Effect.forkDetach(run(elicitationHandler));

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

      return (yield* awaitCompletionOrPause(fiber, pauseQueue)) as ExecutionResult;
    }).pipe(Effect.withSpan("mcp.execute", { attributes }));

  /** Code-mode pause/resume: run the dynamic worker over the full invoker. */
  const startPausableExecution = (code: string): Effect.Effect<ExecutionResult, E> =>
    runWithPause(
      (onElicitation) =>
        codeExecutor
          .execute(code, makeFullInvoker(executor, { onElicitation }, toolDiscoveryProvider))
          .pipe(Effect.withSpan("executor.code.exec")),
      { "mcp.execute.mode": "pausable", "mcp.execute.code_length": code.length },
    );

  /**
   * Non-code-mode pause/resume: invoke a single tool by its wire name. The
   * tool's `ToolResult` envelope (or an engine-level error) is carried back as
   * an `ExecuteResult` so the host renders it the same way it renders a
   * code-mode result. Approval-gated tools pause through the same machinery.
   */
  const invokeToolWithPause = (name: string, args: unknown): Effect.Effect<ExecutionResult, E> =>
    runWithPause(
      (onElicitation) =>
        invokeToolAsExecuteResult(
          makeExecutorToolInvoker(executor, { invokeOptions: { onElicitation } }),
          name,
          args,
        ),
      { "mcp.execute.mode": "pausable_tool", "mcp.tool.name": name },
    );

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
      return (yield* settled) as ExecutionResult;
    }

    const pending = pendingResumes.get(executionId);
    if (pending) {
      yield* Effect.annotateCurrentSpan({ "mcp.execute.resume.joined_inflight": true });
      return (yield* Deferred.await(pending)) as ExecutionResult;
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

    return (yield* awaitCompletionOrPause(paused.fiber, paused.pauseQueue).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          recordSettledOutcome(executionId, exit);
          pendingResumes.delete(executionId);
          yield* Deferred.done(inflight, exit);
        }),
      ),
    )) as ExecutionResult;
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
    return yield* codeExecutor.execute(code, invoker).pipe(Effect.withSpan("executor.code.exec"));
  });

  /**
   * Non-code-mode inline path: invoke a single tool with elicitation handled
   * inline by the provided handler (host with native elicitation support).
   * Mirrors {@link runInlineExecution} for a single tool instead of code.
   */
  const invokeToolInline = Effect.fn("mcp.execute")(function* (
    name: string,
    args: unknown,
    options: { readonly onElicitation: ElicitationHandler },
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.mode": "inline_tool",
      "mcp.tool.name": name,
    });
    return yield* invokeToolAsExecuteResult(
      makeExecutorToolInvoker(executor, {
        invokeOptions: { onElicitation: options.onElicitation },
      }),
      name,
      args,
    );
  });

  /**
   * Enumerate every directly-callable tool with a self-contained input schema.
   * Storage failures are unrecoverable here (the surface can't function without
   * the catalog), so they die rather than surfacing a typed error the caller
   * must thread.
   */
  const listTools: Effect.Effect<readonly ToolListing[]> = executor.tools
    .list({ includeSchemas: true })
    .pipe(
      Effect.map((tools) =>
        tools.map(
          (tool): ToolListing => ({
            name: addressToPath(String(tool.address)),
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: "object" },
          }),
        ),
      ),
      // oxlint-disable-next-line executor/no-effect-escape-hatch -- boundary: ExecutionEngine.listTools exposes no error channel; a catalog read the listing surface can't recover from dies rather than forcing every caller to thread a typed error
      Effect.orDie,
      Effect.withSpan("mcp.list_tools"),
    );

  return {
    execute: runInlineExecution,
    executeWithPause: startPausableExecution,
    resume: resumeExecution,
    getPausedExecution: (executionId) =>
      Effect.sync(() => pausedExecutions.get(executionId) ?? null),
    getDescription: buildExecuteDescription(executor),
    listTools,
    invokeTool: invokeToolInline,
    invokeToolWithPause,
  };
};
