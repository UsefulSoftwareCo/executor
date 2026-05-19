import { Deferred, Effect, Fiber, Predicate, Queue } from "effect";
import type * as Cause from "effect/Cause";

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
  makeExecutorToolInvoker,
  searchTools,
  listExecutorSources,
  describeTool,
} from "./tool-invoker";
import { ExecutionToolError } from "./errors";
import { buildExecuteDescription } from "./description";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionEngineConfig<E extends Cause.YieldableError = CodeExecutionError> = {
  readonly executor: Executor;
  readonly codeExecutor: CodeExecutor<E>;
};

export type ExecutionResult =
  | { readonly status: "completed"; readonly result: ExecuteResult }
  | { readonly status: "paused"; readonly execution: PausedExecution };

export type PausedExecution = {
  readonly id: string;
  readonly elicitationContext: ElicitationContext;
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

  if (result.error) {
    const parts = [`Error: ${result.error}`, ...(logText ? [`\nLogs:\n${logText}`] : [])];
    return {
      text: truncate(parts.join("\n"), MAX_PREVIEW_CHARS),
      structured: { status: "error", error: result.error, logs: result.logs ?? [] },
      isError: true,
    };
  }

  const parts = [
    ...(resultText ? [truncate(resultText, MAX_PREVIEW_CHARS)] : ["(no result)"]),
    ...(logText ? [`\nLogs:\n${logText}`] : []),
  ];
  return {
    text: parts.join("\n"),
    structured: { status: "completed", result: result.result ?? null, logs: result.logs ?? [] },
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
        toolId: String(paused.elicitationContext.toolId),
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

const makeFullInvoker = (executor: Executor, invokeOptions: InvokeOptions): SandboxToolInvoker => {
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

        return searchTools(executor, args.query ?? "", limit, {
          namespace: args.namespace,
          offset,
        }).pipe(
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
};

export const createExecutionEngine = <E extends Cause.YieldableError = CodeExecutionError>(
  config: ExecutionEngineConfig<E>,
): ExecutionEngine<E> => {
  const { executor, codeExecutor } = config;
  const pausedExecutions = new Map<string, InternalPausedExecution<E>>();
  let nextId = 0;

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
   * Start an execution in pause/resume mode.
   *
   * The sandbox is forked as a daemon because paused executions can outlive the
   * caller scope that returned the first pause, such as an HTTP request handler.
   */
  const startPausableExecution = Effect.fn("mcp.execute")(function* (code: string) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.mode": "pausable",
      "mcp.execute.code_length": code.length,
    });

    // Queue preserves pauses that arrive before the previous approval has
    // returned to the caller, which can happen with concurrent tool calls.
    const pauseQueue = yield* Queue.unbounded<InternalPausedExecution<E>>();

    // Will be set once the fiber is forked.
    let fiber: Fiber.Fiber<ExecuteResult, E>;

    const elicitationHandler: ElicitationHandler = (ctx) =>
      Effect.gen(function* () {
        const responseDeferred = yield* Deferred.make<typeof ElicitationResponse.Type>();
        const id = `exec_${++nextId}`;

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

    const invoker = makeFullInvoker(executor, { onElicitation: elicitationHandler });
    fiber = yield* Effect.forkDetach(
      codeExecutor.execute(code, invoker).pipe(Effect.withSpan("executor.code.exec")),
    );

    return (yield* awaitCompletionOrPause(fiber, pauseQueue)) as ExecutionResult;
  });

  /**
   * Resume a paused execution. Completes the response Deferred to unblock the
   * fiber, then races completion against the next queued or future pause.
   */
  const resumeExecution = Effect.fn("mcp.execute.resume")(function* (
    executionId: string,
    response: ResumeResponse,
  ) {
    yield* Effect.annotateCurrentSpan({
      "mcp.execute.resume.action": response.action,
    });

    const paused = pausedExecutions.get(executionId);
    if (!paused) return null;
    pausedExecutions.delete(executionId);

    yield* Deferred.succeed(paused.response, {
      action: response.action as typeof ElicitationResponse.Type.action,
      content: response.content,
    });

    return (yield* awaitCompletionOrPause(paused.fiber, paused.pauseQueue)) as ExecutionResult;
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
    const invoker = makeFullInvoker(executor, {
      onElicitation: options.onElicitation,
    });
    return yield* codeExecutor.execute(code, invoker).pipe(Effect.withSpan("executor.code.exec"));
  });

  return {
    execute: runInlineExecution,
    executeWithPause: startPausableExecution,
    resume: resumeExecution,
    getPausedExecution: (executionId) =>
      Effect.sync(() => pausedExecutions.get(executionId) ?? null),
    getDescription: buildExecuteDescription(executor),
  };
};
